/**
 * Builds the MCP server: wires {@link RouterAdapter} operations up as MCP tools.
 *
 * Read-only tools are always registered. Configuration-changing tools (set
 * wifi, reboot) are only registered when `allowWrite` is set, and the raw
 * command tool only when `allowExec` is set — so an MCP client can never make
 * changes the operator didn't opt into.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RouterAdapter } from "./adapters/types.js";
import type { ServerConfig } from "./config.js";

const PKG_VERSION = "0.1.0";

function jsonContent(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorContent(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

export interface BuildServerOptions {
  adapter: RouterAdapter;
  config: Pick<ServerConfig, "allowWrite" | "allowExec">;
}

/** Create and configure an {@link McpServer} for the given adapter. */
export function buildServer({ adapter, config }: BuildServerOptions): McpServer {
  const server = new McpServer({
    name: "router-mcp",
    version: PKG_VERSION,
  });

  server.registerTool(
    "router_status",
    {
      title: "Router status",
      description:
        "Get router identity and health: model, firmware, hostname, uptime, load average and memory.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return jsonContent(await adapter.getStatus());
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "list_devices",
    {
      title: "List connected devices",
      description:
        "List clients known to the router (DHCP leases plus wireless associations): MAC, IP, hostname, signal (dBm) and interface.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return jsonContent(await adapter.listDevices());
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "list_wifi_networks",
    {
      title: "List WiFi networks",
      description:
        "List configured wireless networks (SSIDs) with their id, enabled state, channel, band and encryption. Use the id with set_wifi.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return jsonContent(await adapter.getWifiNetworks());
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "wan_info",
    {
      title: "WAN connection info",
      description: "Get the upstream/WAN connection: up state, protocol, public IP, gateway and uptime.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return jsonContent(await adapter.getWanInfo());
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  if (config.allowWrite) {
    server.registerTool(
      "set_wifi",
      {
        title: "Change a WiFi network",
        description:
          "Modify an existing wireless network identified by its id (from list_wifi_networks). " +
          "Any subset of fields may be supplied. Changes are committed and the radios reloaded.",
        inputSchema: {
          id: z.string().describe("Wifi network id from list_wifi_networks"),
          enabled: z.boolean().optional().describe("Enable or disable the network"),
          ssid: z.string().optional().describe("New SSID (network name)"),
          password: z.string().optional().describe("New pre-shared key / passphrase"),
          channel: z
            .union([z.number(), z.string()])
            .optional()
            .describe("New radio channel (e.g. 6, 36, or 'auto')"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async (args) => {
        try {
          await adapter.setWifi(args);
          return jsonContent({ ok: true, applied: { ...args, password: args.password ? "<changed>" : undefined } });
        } catch (err) {
          return errorContent(err);
        }
      },
    );

    server.registerTool(
      "reboot_router",
      {
        title: "Reboot router",
        description: "Reboot the router. The connection will drop and the router will be unreachable for ~1-2 minutes.",
        inputSchema: {
          confirm: z
            .boolean()
            .describe("Must be true to actually reboot. A safety guard against accidental reboots."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async ({ confirm }) => {
        if (!confirm) {
          return errorContent(new Error("Reboot not confirmed. Pass confirm=true to proceed."));
        }
        try {
          await adapter.reboot();
          return jsonContent({ ok: true, message: "Reboot command sent." });
        } catch (err) {
          return errorContent(err);
        }
      },
    );
  }

  if (config.allowExec && adapter.runCommand) {
    server.registerTool(
      "run_command",
      {
        title: "Run a raw command",
        description:
          "Run an arbitrary shell command on the router and return its output. Powerful and dangerous — " +
          "only enabled when the operator started the server with exec permission.",
        inputSchema: {
          command: z.string().describe("The shell command to execute on the router"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async ({ command }) => {
        try {
          const out = await adapter.runCommand!(command);
          return { content: [{ type: "text" as const, text: out || "(no output)" }] };
        } catch (err) {
          return errorContent(err);
        }
      },
    );
  }

  return server;
}
