/**
 * Resolves runtime configuration (from explicit options falling back to
 * environment variables) and builds the appropriate {@link RouterAdapter}.
 */
import type { RouterAdapter } from "./adapters/types.js";
import { MockAdapter } from "./adapters/mock.js";
import { OpenWrtAdapter } from "./adapters/openwrt.js";

export type AdapterKind = "openwrt" | "mock";

export interface ServerConfig {
  adapter: AdapterKind;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKeyPath?: string;
  wanInterface?: string;
  /** Allow tools that change router configuration (set wifi, reboot). */
  allowWrite: boolean;
  /** Allow the raw `run_command` tool (arbitrary shell). Implies allowWrite risk. */
  allowExec: boolean;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function envBool(name: string): boolean {
  const v = env(name)?.toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Merge partial CLI options with environment defaults into a full config.
 *
 * Adapter selection: explicit `--adapter`/`ROUTER_ADAPTER` wins; otherwise
 * `openwrt` if a host is provided, else `mock` so things work with no setup.
 */
export function resolveConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const host = overrides.host ?? env("ROUTER_HOST");
  const explicitAdapter = (overrides.adapter ?? env("ROUTER_ADAPTER")) as AdapterKind | undefined;
  const adapter: AdapterKind = explicitAdapter ?? (host ? "openwrt" : "mock");

  const portRaw = overrides.port ?? (env("ROUTER_PORT") ? Number(env("ROUTER_PORT")) : undefined);

  return {
    adapter,
    host,
    port: portRaw,
    username: overrides.username ?? env("ROUTER_USER"),
    password: overrides.password ?? env("ROUTER_PASSWORD"),
    privateKeyPath: overrides.privateKeyPath ?? env("ROUTER_KEY"),
    wanInterface: overrides.wanInterface ?? env("ROUTER_WAN_IFACE"),
    allowWrite: overrides.allowWrite ?? envBool("ROUTER_ALLOW_WRITE"),
    allowExec: overrides.allowExec ?? envBool("ROUTER_ALLOW_EXEC"),
  };
}

/** Construct a {@link RouterAdapter} from a resolved config. */
export function createAdapter(config: ServerConfig): RouterAdapter {
  if (config.adapter === "mock") return new MockAdapter();

  if (config.adapter === "openwrt") {
    if (!config.host) {
      throw new Error(
        "The openwrt adapter needs a host. Set ROUTER_HOST (or --host), or use --adapter mock.",
      );
    }
    return new OpenWrtAdapter({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      privateKeyPath: config.privateKeyPath,
      wanInterface: config.wanInterface,
    });
  }

  throw new Error(`Unknown adapter: ${String(config.adapter)}`);
}
