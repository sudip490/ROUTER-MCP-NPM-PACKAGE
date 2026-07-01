# router-mcp

[![npm](https://img.shields.io/npm/v/@subashgautam/router-mcp.svg)](https://www.npmjs.com/package/@subashgautam/router-mcp)

> A **Model Context Protocol (MCP)** server **+ CLI** that lets an AI assistant (Claude, or any MCP client) **monitor and control your WiFi router** — list connected devices, inspect WiFi networks, check WAN status, change SSIDs, reboot, and more.

> **Published as `@subashgautam/router-mcp`.** After a global install the CLI command is just `router-mcp`.

Built on [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk). Designed around **pluggable adapters**, so it can target any router family. It ships with:

- **`openwrt`** — talks to OpenWrt (and most derivatives) over SSH using `ubus` / `uci`.
- **`mock`** — realistic fake data so you can try everything with **no hardware**.

It is also a normal **TypeScript/JavaScript library** you can import.

---

## Features

- 🔌 **MCP server** — exposes router operations as MCP tools to any MCP client.
- 🖥️ **CLI** — drive your router straight from the terminal (`router-mcp devices`, `status`, `wifi`, ...).
- 🧩 **Pluggable adapters** — add a new router backend by implementing one interface.
- 🔒 **Safe by default** — read-only unless you explicitly opt in to writes (`--allow-write`) and raw command execution (`--allow-exec`).
- 📦 **Library + CLI** — `import { OpenWrtAdapter } from "@subashgautam/router-mcp"` or run the binary.

---

## Install

```bash
# Use immediately with no install
npx @subashgautam/router-mcp status --adapter mock

# Or install globally for the CLI (provides the `router-mcp` command)
npm install -g @subashgautam/router-mcp

# Or as a project dependency (library use)
npm install @subashgautam/router-mcp
```

Requires **Node.js >= 18**.

---

## Quick start

### 1. Try it with no hardware (mock adapter)

```bash
npx @subashgautam/router-mcp status   --adapter mock
npx @subashgautam/router-mcp devices  --adapter mock
npx @subashgautam/router-mcp wifi     --adapter mock
```

> Tip: after `npm install -g @subashgautam/router-mcp` you can drop the `npx @subashgautam/` prefix and just run `router-mcp status` etc.

### 2. Point it at a real OpenWrt router

```bash
# Prefer the env var (or --key) so the password isn't visible in the process list:
ROUTER_HOST=192.168.1.1 ROUTER_USER=root ROUTER_PASSWORD='yourpass' npx @subashgautam/router-mcp devices

# --password also works, but see the security note below.
npx @subashgautam/router-mcp devices --host 192.168.1.1 --user root --password 'yourpass'
```

### 3. Use it as an MCP server (Claude Desktop, etc.)

Add to your MCP client config (see [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json)):

```jsonc
{
  "mcpServers": {
    "router": {
      "command": "npx",
      "args": ["-y", "@subashgautam/router-mcp", "serve"],
      "env": {
        "ROUTER_ADAPTER": "openwrt",
        "ROUTER_HOST": "192.168.1.1",
        "ROUTER_USER": "root",
        "ROUTER_PASSWORD": "your-router-password",
        "ROUTER_ALLOW_WRITE": "1"
      }
    }
  }
}
```

Then ask your assistant things like *"which devices are connected to my router?"* or *"rename my 2.4GHz WiFi to HomeNet"*.

---

## MCP tools

| Tool | Permission | Description |
|------|-----------|-------------|
| `router_status` | read | Model, firmware, hostname, uptime, load, memory. |
| `list_devices` | read | Connected/known clients: MAC, IP, hostname, signal, interface. |
| `list_wifi_networks` | read | Configured SSIDs with id, state, channel, band, encryption. |
| `wan_info` | read | WAN/upstream: up state, protocol, public IP, gateway, uptime. |
| `set_wifi` | **write** | Change an SSID's name, password, channel, or enabled state. |
| `reboot_router` | **write** | Reboot the router (requires `confirm: true`). |
| `run_command` | **exec** | Run a raw shell command on the router. |

Write tools appear **only** when the server is started with `--allow-write`; `run_command` only with `--allow-exec`.

---

## CLI reference

```
router-mcp [serve] [options]      Start the MCP server over stdio (default)
router-mcp <command> [options]    Run a command directly against the router

Commands:
  serve            Run the MCP server (stdio). Default when no command given.
  status           Show router model, firmware, uptime, load, memory.
  devices          List connected/known devices.
  wifi             List configured WiFi networks.
  wan              Show WAN/upstream connection info.
  reboot           Reboot the router (needs --allow-write).
  exec "<cmd>"     Run a raw shell command on the router (needs --allow-exec).

Options:
  --adapter <openwrt|mock>   Default: openwrt if --host given, else mock.
  --host --port --user --password --key --wan-iface
  --allow-write  --allow-exec  --json  -h/--help  -v/--version
```

### Environment variables

`ROUTER_ADAPTER`, `ROUTER_HOST`, `ROUTER_PORT`, `ROUTER_USER`, `ROUTER_PASSWORD`, `ROUTER_KEY`, `ROUTER_WAN_IFACE`, `ROUTER_ALLOW_WRITE`, `ROUTER_ALLOW_EXEC`.

---

## Library usage

```ts
import { OpenWrtAdapter, startStdioServer } from "@subashgautam/router-mcp";

// Use an adapter directly
const router = new OpenWrtAdapter({ host: "192.168.1.1", password: "..." });
console.log(await router.getStatus());
console.log(await router.listDevices());
await router.close();

// Or start a full MCP server programmatically
await startStdioServer({ adapter: "openwrt", host: "192.168.1.1", password: "...", allowWrite: true });
```

---

## Writing a custom adapter

Implement the `RouterAdapter` interface and pass an instance to `buildServer`:

```ts
import { buildServer, type RouterAdapter } from "@subashgautam/router-mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

class MyRouterAdapter implements RouterAdapter {
  readonly name = "myrouter";
  async getStatus() { /* ... */ return {}; }
  async listDevices() { return []; }
  async getWifiNetworks() { return []; }
  async getWanInfo() { return {}; }
  async setWifi() { /* ... */ }
  async reboot() { /* ... */ }
}

const server = buildServer({
  adapter: new MyRouterAdapter(),
  config: { allowWrite: true, allowExec: false },
});
await server.connect(new StdioServerTransport());
```

---

## Security notes

- The server is **read-only by default**. Enabling `--allow-write` / `--allow-exec` lets an AI client change settings or run commands on your router — only enable what you need.
- **Avoid `--password` on the command line** — process arguments are world-readable on most systems (`ps aux`, `/proc/<pid>/cmdline`), so the password leaks to other local users. Prefer **key-based SSH auth** (`--key`) or the **`ROUTER_PASSWORD`** environment variable.
- `run_command` is powerful; treat it like giving shell access. It is only available with `--allow-exec`.
- Wifi network ids passed to `set_wifi` are validated against the uci section-name charset (`[A-Za-z0-9_]`) before use, so a malicious id cannot inject shell commands.

---

## License

MIT © SwiftTech
