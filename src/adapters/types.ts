/**
 * Common types and the adapter contract that every router backend implements.
 *
 * The MCP server and CLI are written entirely against {@link RouterAdapter}, so
 * supporting a new router family (Asus, MikroTik, TR-069/ACS, a vendor HTTP API,
 * ...) is just a matter of adding a new file in `src/adapters/` that implements
 * this interface.
 */

/** A client currently known to the router (from DHCP leases / wifi assoc). */
export interface RouterDevice {
  /** MAC address, upper-cased and colon-separated. */
  mac: string;
  ip?: string;
  hostname?: string;
  /** Signal strength in dBm (wireless clients only). */
  signal?: number;
  /** Interface the client is associated with, e.g. `wlan0`. */
  iface?: string;
  /** Whether the device is currently associated/online. */
  connected?: boolean;
}

/** A configured wireless network (SSID). */
export interface WifiNetwork {
  /** Stable identifier used to address this network in {@link RouterAdapter.setWifi}. */
  id: string;
  ssid: string;
  enabled: boolean;
  channel?: number | string;
  /** Encryption mode as reported by the router, e.g. `psk2`, `sae`, `none`. */
  encryption?: string;
  /** Radio band, e.g. `2g` or `5g`, when known. */
  band?: string;
}

/** High level health / identity of the router. */
export interface RouterStatus {
  model?: string;
  firmware?: string;
  hostname?: string;
  uptimeSeconds?: number;
  /** 1/5/15 minute load averages. */
  load?: [number, number, number];
  memory?: { totalBytes: number; freeBytes: number };
}

/** WAN / upstream connection details. */
export interface WanInfo {
  up?: boolean;
  proto?: string;
  ip?: string;
  gateway?: string;
  uptimeSeconds?: number;
}

/** Mutation request for an existing wireless network. */
export interface SetWifiOptions {
  /** The {@link WifiNetwork.id} to modify. */
  id: string;
  enabled?: boolean;
  ssid?: string;
  /** New pre-shared key / passphrase. */
  password?: string;
  channel?: number | string;
}

/**
 * The contract every router backend implements. Read methods are always
 * available; write methods may be gated by the server's permission flags.
 */
export interface RouterAdapter {
  /** Short adapter identifier, e.g. `openwrt` or `mock`. */
  readonly name: string;

  getStatus(): Promise<RouterStatus>;
  listDevices(): Promise<RouterDevice[]>;
  getWifiNetworks(): Promise<WifiNetwork[]>;
  getWanInfo(): Promise<WanInfo>;

  /** Apply changes to a wireless network and persist them. */
  setWifi(opts: SetWifiOptions): Promise<void>;

  /** Reboot the router. The connection is expected to drop. */
  reboot(): Promise<void>;

  /**
   * Run a raw command on the router and return its combined output.
   * Optional: adapters without a shell (e.g. an HTTP-only API) omit it.
   */
  runCommand?(command: string): Promise<string>;

  /** Release any held resources (SSH sessions, sockets, ...). */
  close?(): Promise<void>;
}
