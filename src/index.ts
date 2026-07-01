/**
 * router-mcp — a Model Context Protocol server + CLI for monitoring and
 * controlling WiFi routers, with a pluggable adapter design.
 *
 * @example Library usage — start a stdio MCP server
 * ```ts
 * import { startStdioServer } from "@subashgautam/router-mcp";
 * await startStdioServer({ adapter: "openwrt", host: "192.168.1.1", password: "...", allowWrite: true });
 * ```
 *
 * @example Library usage — use an adapter directly
 * ```ts
 * import { OpenWrtAdapter } from "@subashgautam/router-mcp";
 * const router = new OpenWrtAdapter({ host: "192.168.1.1", password: "..." });
 * console.log(await router.listDevices());
 * await router.close();
 * ```
 *
 * @packageDocumentation
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { resolveConfig, createAdapter, type ServerConfig } from "./config.js";

export type {
  RouterAdapter,
  RouterDevice,
  RouterStatus,
  WanInfo,
  WifiNetwork,
  SetWifiOptions,
} from "./adapters/types.js";
export { MockAdapter } from "./adapters/mock.js";
export { OpenWrtAdapter, type OpenWrtAdapterOptions } from "./adapters/openwrt.js";
export { buildServer, type BuildServerOptions } from "./server.js";
export {
  resolveConfig,
  createAdapter,
  type ServerConfig,
  type AdapterKind,
} from "./config.js";

/**
 * Resolve config, build the MCP server and connect it over stdio. This is what
 * the CLI runs and what MCP clients (Claude Desktop, etc.) launch. Resolves
 * when the transport closes.
 */
export async function startStdioServer(overrides: Partial<ServerConfig> = {}): Promise<void> {
  const config = resolveConfig(overrides);
  const adapter = createAdapter(config);
  const server = buildServer({ adapter, config });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    try {
      await adapter.close?.();
    } finally {
      await server.close();
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
