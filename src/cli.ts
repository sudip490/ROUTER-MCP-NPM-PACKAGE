#!/usr/bin/env node
/**
 * router-mcp CLI.
 *
 * With no command (or `serve`) it runs the MCP server over stdio — this is how
 * MCP clients launch it. The other subcommands (`status`, `devices`, `wifi`,
 * `wan`, `reboot`, `exec`) hit the same adapter directly so you can drive a
 * router straight from a terminal.
 */
import { startStdioServer } from "./index.js";
import { resolveConfig, createAdapter, type ServerConfig } from "./config.js";

const VERSION = "0.1.0";

const HELP = `router-mcp v${VERSION} — MCP server + CLI for WiFi routers

USAGE
  router-mcp [serve] [options]        Start the MCP server over stdio (default)
  router-mcp <command> [options]      Run a command directly against the router

COMMANDS
  serve                 Run the MCP server (stdio). Default when no command given.
  status                Show router model, firmware, uptime, load, memory.
  devices               List connected/known devices.
  wifi                  List configured WiFi networks (SSIDs).
  wan                   Show WAN/upstream connection info.
  reboot                Reboot the router (needs --allow-write).
  exec "<command>"      Run a raw shell command on the router (needs --allow-exec).

OPTIONS
  --adapter <openwrt|mock>   Backend to use. Default: openwrt if --host given, else mock.
  --host <ip|hostname>       Router address (SSH).
  --port <n>                 SSH port (default 22).
  --user <name>              SSH username (default root).
  --password <pw>            SSH password.
  --key <path>               Path to a private key file.
  --wan-iface <name>         Interface to treat as WAN (default: wan).
  --allow-write              Permit configuration changes (set wifi, reboot).
  --allow-exec               Permit the raw command tool / 'exec' subcommand.
  --json                     Print raw JSON (direct commands).
  -h, --help                 Show this help.
  -v, --version              Show version.

ENV VARS
  ROUTER_ADAPTER, ROUTER_HOST, ROUTER_PORT, ROUTER_USER, ROUTER_PASSWORD,
  ROUTER_KEY, ROUTER_WAN_IFACE, ROUTER_ALLOW_WRITE, ROUTER_ALLOW_EXEC

EXAMPLES
  # Drive a router from the shell
  router-mcp devices --host 192.168.1.1 --password secret

  # Run as an MCP server (what an MCP client invokes)
  ROUTER_HOST=192.168.1.1 ROUTER_PASSWORD=secret router-mcp serve --allow-write

  # Try everything with no hardware
  router-mcp status --adapter mock
`;

interface ParsedArgs {
  command: string;
  positionals: string[];
  overrides: Partial<ServerConfig>;
  json: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const overrides: Partial<ServerConfig> = {};
  const positionals: string[] = [];
  let json = false;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i];
    switch (arg) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "-v":
      case "--version":
        version = true;
        break;
      case "--json":
        json = true;
        break;
      case "--allow-write":
        overrides.allowWrite = true;
        break;
      case "--allow-exec":
        overrides.allowExec = true;
        break;
      case "--adapter":
        overrides.adapter = next() as ServerConfig["adapter"];
        break;
      case "--host":
        overrides.host = next();
        break;
      case "--port":
        overrides.port = Number(next());
        break;
      case "--user":
        overrides.username = next();
        break;
      case "--password":
        overrides.password = next();
        break;
      case "--key":
        overrides.privateKeyPath = next();
        break;
      case "--wan-iface":
        overrides.wanInterface = next();
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positionals.push(arg);
    }
  }

  const command = positionals.shift() ?? "serve";
  return { command, positionals, overrides, json, help, version };
}

function print(json: boolean, label: string, data: unknown): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`\n${label}`);
  console.log(JSON.stringify(data, null, 2));
}

async function runDirect(parsed: ParsedArgs): Promise<number> {
  const config = resolveConfig(parsed.overrides);
  const adapter = createAdapter(config);
  try {
    switch (parsed.command) {
      case "status":
        print(parsed.json, "Router status:", await adapter.getStatus());
        break;
      case "devices":
        print(parsed.json, "Connected devices:", await adapter.listDevices());
        break;
      case "wifi":
        print(parsed.json, "WiFi networks:", await adapter.getWifiNetworks());
        break;
      case "wan":
        print(parsed.json, "WAN info:", await adapter.getWanInfo());
        break;
      case "reboot": {
        if (!config.allowWrite) {
          console.error("Refusing to reboot without --allow-write (or ROUTER_ALLOW_WRITE=1).");
          return 1;
        }
        await adapter.reboot();
        console.log("Reboot command sent.");
        break;
      }
      case "exec": {
        if (!config.allowExec) {
          console.error("Refusing to exec without --allow-exec (or ROUTER_ALLOW_EXEC=1).");
          return 1;
        }
        const command = parsed.positionals.join(" ").trim();
        if (!command) {
          console.error('Usage: router-mcp exec "<command>"');
          return 1;
        }
        if (!adapter.runCommand) {
          console.error(`Adapter "${adapter.name}" does not support raw commands.`);
          return 1;
        }
        const out = await adapter.runCommand(command);
        console.log(out || "(no output)");
        break;
      }
      default:
        console.error(`Unknown command: ${parsed.command}\n`);
        console.error(HELP);
        return 1;
    }
    return 0;
  } finally {
    await adapter.close?.();
  }
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    console.log(HELP);
    return;
  }
  if (parsed.version) {
    console.log(VERSION);
    return;
  }

  if (parsed.command === "serve") {
    // IMPORTANT: stdout is the MCP transport here; logs must go to stderr.
    const config = resolveConfig(parsed.overrides);
    console.error(
      `router-mcp: starting MCP server (adapter=${config.adapter}` +
        (config.host ? `, host=${config.host}` : "") +
        `, write=${config.allowWrite}, exec=${config.allowExec})`,
    );
    await startStdioServer(parsed.overrides);
    return; // server keeps running until transport closes
  }

  process.exitCode = await runDirect(parsed);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
