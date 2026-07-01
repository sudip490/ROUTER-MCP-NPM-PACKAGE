/**
 * OpenWrt adapter.
 *
 * Talks to an OpenWrt router over SSH and uses its standard tooling — `ubus`
 * (system info / network state), `uci` (wireless config) and the DHCP lease
 * file — to implement the {@link RouterAdapter} contract. Works with stock
 * OpenWrt 21.02+ and most derivatives (and is a good template for DD-WRT etc.).
 */
import { NodeSSH } from "node-ssh";
import type {
  RouterAdapter,
  RouterDevice,
  RouterStatus,
  WanInfo,
  WifiNetwork,
  SetWifiOptions,
} from "./types.js";

export interface OpenWrtAdapterOptions {
  host: string;
  port?: number;
  username?: string;
  /** Password auth. Prefer {@link OpenWrtAdapterOptions.privateKeyPath} where possible. */
  password?: string;
  /** Path to a private key file for key-based auth. */
  privateKeyPath?: string;
  /** Interface name(s) to treat as WAN for {@link OpenWrtAdapter.getWanInfo}. */
  wanInterface?: string;
  /** Connection timeout in milliseconds (default 15000). */
  timeoutMs?: number;
}

function normalizeMac(mac: string): string {
  return mac.trim().toUpperCase();
}

/** Parse `key=value` ubus/uci-style lines (best effort). */
function tryJson<T = unknown>(raw: string): T | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * uci section / device names are restricted to `[A-Za-z0-9_]`. Because these
 * identifiers are interpolated into shell commands, anything outside that
 * charset is rejected up front — this is the guard that prevents command
 * injection via a crafted `id` (e.g. `"x; reboot; #"`) reaching the router.
 */
function assertUciName(label: string, value: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(
      `Invalid ${label} "${value}": expected a uci section name (letters, digits and underscore only).`,
    );
  }
}

export class OpenWrtAdapter implements RouterAdapter {
  readonly name = "openwrt";

  private ssh = new NodeSSH();
  private connected = false;
  private readonly opts: Required<Pick<OpenWrtAdapterOptions, "host" | "port" | "username" | "timeoutMs">> &
    OpenWrtAdapterOptions;

  constructor(options: OpenWrtAdapterOptions) {
    if (!options.host) throw new Error("OpenWrtAdapter requires a host");
    this.opts = {
      port: 22,
      username: "root",
      timeoutMs: 15000,
      ...options,
    };
  }

  private async connect(): Promise<void> {
    if (this.connected) return;
    await this.ssh.connect({
      host: this.opts.host,
      port: this.opts.port,
      username: this.opts.username,
      password: this.opts.password,
      privateKeyPath: this.opts.privateKeyPath,
      readyTimeout: this.opts.timeoutMs,
    });
    this.connected = true;
  }

  /** Run a command and return stdout, throwing on a non-zero exit code. */
  private async exec(command: string): Promise<string> {
    await this.connect();
    const res = await this.ssh.execCommand(command);
    if (res.code && res.code !== 0) {
      const detail = res.stderr.trim() || res.stdout.trim() || `exit code ${res.code}`;
      throw new Error(`Command failed (${command}): ${detail}`);
    }
    return res.stdout;
  }

  /** Run a command and return combined output, never throwing on exit code. */
  private async execSoft(command: string): Promise<string> {
    await this.connect();
    const res = await this.ssh.execCommand(command);
    return [res.stdout, res.stderr].filter(Boolean).join("\n");
  }

  async getStatus(): Promise<RouterStatus> {
    const [boardRaw, infoRaw] = await Promise.all([
      this.execSoft("ubus call system board"),
      this.execSoft("ubus call system info"),
    ]);

    const board = tryJson<{
      model?: string;
      board_name?: string;
      hostname?: string;
      kernel?: string;
      release?: { distribution?: string; version?: string; description?: string };
    }>(boardRaw);

    const info = tryJson<{
      uptime?: number;
      load?: [number, number, number];
      memory?: { total?: number; free?: number };
    }>(infoRaw);

    const firmware =
      board?.release?.description ??
      ([board?.release?.distribution, board?.release?.version].filter(Boolean).join(" ") || undefined);

    // ubus load values are scaled by 65536.
    const load = info?.load
      ? (info.load.map((n) => Math.round((n / 65536) * 100) / 100) as [number, number, number])
      : undefined;

    return {
      model: board?.model ?? board?.board_name,
      firmware: firmware || undefined,
      hostname: board?.hostname,
      uptimeSeconds: info?.uptime,
      load,
      memory:
        info?.memory && info.memory.total !== undefined
          ? { totalBytes: info.memory.total, freeBytes: info.memory.free ?? 0 }
          : undefined,
    };
  }

  async listDevices(): Promise<RouterDevice[]> {
    const byMac = new Map<string, RouterDevice>();

    // 1. DHCP leases: "<expiry> <mac> <ip> <hostname> <clientid>". A lease only
    //    means the router has *seen* the client; it persists after the device
    //    goes offline, so we do NOT treat a lease alone as "connected".
    const leases = await this.execSoft("cat /tmp/dhcp.leases 2>/dev/null");
    for (const line of leases.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const mac = normalizeMac(parts[1] ?? "");
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) continue;
      byMac.set(mac, {
        mac,
        ip: parts[2],
        hostname: parts[3] && parts[3] !== "*" ? parts[3] : undefined,
        connected: false,
      });
    }

    // 2. Neighbour/ARP table: marks who is actually reachable right now. States
    //    REACHABLE/STALE/DELAY/PROBE mean the host has been seen recently.
    const neigh = await this.execSoft("ip neigh show 2>/dev/null");
    for (const line of neigh.split("\n")) {
      const m = line.match(/lladdr\s+([0-9A-Fa-f:]{17}).*\b(REACHABLE|STALE|DELAY|PROBE)\b/);
      if (!m) continue;
      const mac = normalizeMac(m[1]!);
      const ipMatch = line.match(/^(\S+)\s+dev\b/);
      const existing = byMac.get(mac) ?? { mac };
      existing.connected = true;
      if (!existing.ip && ipMatch) existing.ip = ipMatch[1];
      byMac.set(mac, existing);
    }

    // 3. Wireless association info (adds signal + iface, marks who is on wifi).
    //    Iterate each wifi interface reported by iwinfo and read its assoclist.
    const assoc = await this.execSoft(
      'for i in $(iwinfo 2>/dev/null | grep -oE "^[a-zA-Z0-9._-]+" ); do ' +
        'echo "@@iface $i"; iwinfo "$i" assoclist 2>/dev/null; done',
    );
    let iface: string | undefined;
    for (const rawLine of assoc.split("\n")) {
      const line = rawLine.trim();
      const ifaceMatch = line.match(/^@@iface\s+(\S+)/);
      if (ifaceMatch) {
        iface = ifaceMatch[1];
        continue;
      }
      // "00:11:22:33:44:55  -55 dBm / -95 dBm (SNR 40)  1000 ms ago"
      const m = line.match(/^([0-9A-Fa-f:]{17})\s+(-?\d+)\s*dBm/);
      if (!m) continue;
      const mac = normalizeMac(m[1]!);
      const signal = Number(m[2]);
      const existing = byMac.get(mac) ?? { mac, connected: true };
      existing.signal = signal;
      existing.iface = iface;
      existing.connected = true;
      byMac.set(mac, existing);
    }

    return [...byMac.values()];
  }

  async getWifiNetworks(): Promise<WifiNetwork[]> {
    const raw = await this.execSoft("uci show wireless 2>/dev/null");

    // Collect per-section key/value pairs.
    const sections = new Map<string, { type?: string; props: Record<string, string> }>();
    for (const line of raw.split("\n")) {
      const m = line.match(/^wireless\.([^.=]+)(?:\.([^=]+))?=(.*)$/);
      if (!m) continue;
      const [, section, key, valueRaw] = m;
      const value = (valueRaw ?? "").replace(/^'(.*)'$/, "$1");
      const entry = sections.get(section!) ?? { props: {} };
      if (key === undefined) {
        entry.type = value; // e.g. wifi-iface / wifi-device
      } else {
        entry.props[key] = value;
      }
      sections.set(section!, entry);
    }

    const networks: WifiNetwork[] = [];
    for (const [id, entry] of sections) {
      if (entry.type !== "wifi-iface") continue;
      const deviceId = entry.props["device"];
      const device = deviceId ? sections.get(deviceId) : undefined;
      const channel = device?.props["channel"];
      const band = device?.props["band"] ?? device?.props["hwmode"];
      networks.push({
        id,
        ssid: entry.props["ssid"] ?? "(unnamed)",
        enabled: entry.props["disabled"] !== "1",
        channel: channel && channel !== "auto" ? channel : undefined,
        encryption: entry.props["encryption"],
        band,
      });
    }
    return networks;
  }

  async getWanInfo(): Promise<WanInfo> {
    const candidates = this.opts.wanInterface
      ? [this.opts.wanInterface]
      : ["wan", "wwan", "wan6"];

    for (const ifname of candidates) {
      const raw = await this.execSoft(`ubus call network.interface.${ifname} status 2>/dev/null`);
      const status = tryJson<{
        up?: boolean;
        proto?: string;
        uptime?: number;
        "ipv4-address"?: Array<{ address?: string }>;
        route?: Array<{ nexthop?: string; target?: string }>;
      }>(raw);
      if (!status) continue;
      const ip = status["ipv4-address"]?.[0]?.address;
      const gateway = status.route?.find((r) => r.target === "0.0.0.0" || !r.target)?.nexthop;
      return {
        up: status.up,
        proto: status.proto,
        ip,
        gateway,
        uptimeSeconds: status.uptime,
      };
    }
    return { up: false };
  }

  async setWifi(opts: SetWifiOptions): Promise<void> {
    // The id is interpolated into shell commands below, so validate it against
    // the legal uci section-name charset before building anything.
    assertUciName("wifi id", opts.id);

    const sets: string[] = [];
    const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;

    if (opts.ssid !== undefined) sets.push(`uci set wireless.${opts.id}.ssid=${q(opts.ssid)}`);
    if (opts.password !== undefined) sets.push(`uci set wireless.${opts.id}.key=${q(opts.password)}`);
    if (opts.enabled !== undefined)
      sets.push(`uci set wireless.${opts.id}.disabled=${opts.enabled ? "'0'" : "'1'"}`);

    if (opts.channel !== undefined) {
      // channel lives on the radio device the iface belongs to
      const device = (await this.execSoft(`uci -q get wireless.${opts.id}.device`)).trim();
      if (!device) throw new Error(`Could not resolve radio device for wifi "${opts.id}"`);
      // device comes from router output; validate it too before interpolating.
      assertUciName("radio device", device);
      sets.push(`uci set wireless.${device}.channel=${q(String(opts.channel))}`);
    }

    if (sets.length === 0) return;
    sets.push("uci commit wireless");
    sets.push("wifi reload");
    await this.exec(sets.join(" && "));
  }

  async reboot(): Promise<void> {
    // Fire and forget; the SSH channel drops as the box goes down.
    await this.execSoft("reboot");
    this.connected = false;
  }

  async runCommand(command: string): Promise<string> {
    return this.execSoft(command);
  }

  async close(): Promise<void> {
    if (this.connected) {
      this.ssh.dispose();
      this.connected = false;
    }
  }
}
