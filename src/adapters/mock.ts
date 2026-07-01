/**
 * In-memory mock adapter.
 *
 * Returns plausible, mutable fake data so the server and CLI work out of the
 * box with zero hardware — handy for demos, MCP client testing, and CI.
 */
import type {
  RouterAdapter,
  RouterDevice,
  RouterStatus,
  WanInfo,
  WifiNetwork,
  SetWifiOptions,
} from "./types.js";

export class MockAdapter implements RouterAdapter {
  readonly name = "mock";

  private bootedAt = Date.now() - 36 * 3600 * 1000;

  private devices: RouterDevice[] = [
    { mac: "AC:DE:48:00:11:22", ip: "192.168.1.42", hostname: "subash-laptop", signal: -48, iface: "wlan1", connected: true },
    { mac: "F0:9F:C2:AB:CD:EF", ip: "192.168.1.51", hostname: "pixel-phone", signal: -61, iface: "wlan0", connected: true },
    { mac: "B8:27:EB:12:34:56", ip: "192.168.1.10", hostname: "media-server", iface: "eth0", connected: true },
  ];

  private wifi: WifiNetwork[] = [
    { id: "wlan_2g", ssid: "SwiftTech", enabled: true, channel: 6, encryption: "psk2", band: "2g" },
    { id: "wlan_5g", ssid: "SwiftTech-5G", enabled: true, channel: 36, encryption: "sae", band: "5g" },
    { id: "guest_2g", ssid: "SwiftTech-Guest", enabled: false, channel: 6, encryption: "psk2", band: "2g" },
  ];

  async getStatus(): Promise<RouterStatus> {
    return {
      model: "Mock Router X1000",
      firmware: "router-mcp-mock 1.0 (OpenWrt 23.05 compatible)",
      hostname: "mock-router",
      uptimeSeconds: Math.floor((Date.now() - this.bootedAt) / 1000),
      load: [0.12, 0.18, 0.21],
      memory: { totalBytes: 256 * 1024 * 1024, freeBytes: 140 * 1024 * 1024 },
    };
  }

  async listDevices(): Promise<RouterDevice[]> {
    return this.devices.map((d) => ({ ...d }));
  }

  async getWifiNetworks(): Promise<WifiNetwork[]> {
    return this.wifi.map((w) => ({ ...w }));
  }

  async getWanInfo(): Promise<WanInfo> {
    return {
      up: true,
      proto: "pppoe",
      ip: "103.10.29.77",
      gateway: "103.10.29.1",
      uptimeSeconds: Math.floor((Date.now() - this.bootedAt) / 1000),
    };
  }

  async setWifi(opts: SetWifiOptions): Promise<void> {
    const net = this.wifi.find((w) => w.id === opts.id);
    if (!net) throw new Error(`No wifi network with id "${opts.id}"`);
    if (opts.enabled !== undefined) net.enabled = opts.enabled;
    if (opts.ssid !== undefined) net.ssid = opts.ssid;
    if (opts.channel !== undefined) net.channel = opts.channel;
    // password intentionally not stored / echoed back
  }

  async reboot(): Promise<void> {
    this.bootedAt = Date.now();
  }

  async runCommand(command: string): Promise<string> {
    return `mock: would have run \`${command}\``;
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
