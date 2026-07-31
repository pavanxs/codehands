# CodeHands Setup Tutorial

Code from any AI chat. This guide gets you running in under 5 minutes.

## What You Get

After setup, you can open ChatGPT or Claude and tell it to edit files, run
commands, and manage code on your local machine — from any device.

## Prerequisites

- Windows 10/11 (macOS/Linux also works)
- Node.js 22 or newer: https://nodejs.org
- Git: https://git-scm.com
- pnpm: `npm install -g pnpm`

## Step 1: Install Codex (the execution engine)

```bash
npm install -g @openai/codex
```

Verify it works:

```bash
codex --version
```

## Step 2: Clone and build CodeHands

```bash
git clone https://github.com/AjayPavan/codehands.git
cd codehands
pnpm install
pnpm run build
```

## Step 3: Make it globally available

```bash
cd apps/local-agent
npm link
cd ../..
```

Now `codehands` works from anywhere on your system.

## Step 4: Initialize config

```bash
codehands init
```

This creates `~/.codehands/config.json`. Open it and add your project folders:

```json
{
  "workspaces": [
    "C:/Users/you/projects/my-app",
    "C:/Users/you/projects/another-project"
  ],
  "port": 3100,
  "blockedCommands": []
}
```

Only folders listed here can be accessed by AI.

## Step 5: Start the server

```bash
codehands start
```

You should see:

```
Starting exec-server...
exec-server ready.
CodeHands MCP server running on http://localhost:3100/mcp
Health check: http://localhost:3100/health
Workspaces: C:/Users/you/projects/my-app
```

## Connecting AI Clients

### Claude Desktop (recommended for local use)

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "codehands": {
      "command": "codehands",
      "args": ["stdio"]
    }
  }
}
```

Restart Claude Desktop. Tools appear automatically.

### Claude.ai or ChatGPT (remote — needs tunnel)

Your server runs locally. Cloud AI services can't reach `localhost`. You need
a tunnel to create a public HTTPS URL.

**Quick option — ngrok:**

```bash
npm install -g ngrok
ngrok http 3100
```

Copy the HTTPS URL (like `https://abc123.ngrok-free.app`).

**Better option — Tailscale Funnel (free, permanent URL):**

```bash
tailscale funnel 3100
```

Then in Claude.ai or ChatGPT settings, add the MCP server URL:
`https://your-url/mcp`

## How It Works

```
┌─────────────┐        ┌───────────┐        ┌─────────────┐
│ ChatGPT /   │──MCP──▶│ CodeHands │──RPC──▶│ Codex       │
│ Claude Chat │◀───────│ (server)  │◀───────│ exec-server │
└─────────────┘        └───────────┘        └─────────────┘
   AI brain              Router               Executor
   (decides)            (validates)           (does the work)
```

The AI decides what to do. CodeHands validates it's safe. The exec-server
executes it.

## Available Tools (what the AI can do)

| Tool | What it does |
| --- | --- |
| fs_readFile | Read a file |
| fs_writeFile | Write/create a file |
| fs_createDirectory | Create folders |
| fs_readDirectory | List folder contents |
| fs_walk | Walk directory tree |
| fs_remove | Delete files/folders |
| fs_copy | Copy files |
| fs_getMetadata | Get file info |
| process_start | Run a terminal command |
| process_read | Read command output |
| process_write | Send input to a command |
| process_terminate | Kill a command |
| process_signal | Send Ctrl+C |
| http_request | Fetch a URL |
| workspace_list | List available projects |
| workspace_set | Switch active project |

## Security

- **Workspace isolation:** AI can only access folders you explicitly approve
- **Blocked commands:** Dangerous commands (rm -rf /, format C:, etc.) are rejected
- **No API keys needed:** Everything runs locally, no cloud calls
- **Audit log:** Every tool call is logged to `~/.codehands/logs/`

## Updating

```bash
cd codehands
git pull
pnpm install
pnpm run build
```

Then restart `codehands start`.

## Troubleshooting

**"address already in use"** — Another instance is running. Kill it:
```bash
# Windows
netstat -ano | findstr :3100
taskkill /PID <pid> /F

# Mac/Linux
lsof -i :3100
kill <pid>
```

**"codex binary not found"** — Run `npm install -g @openai/codex` again.

**"no active workspace set"** — Make sure your config has at least one workspace.
If you have only one, it's auto-activated.

**Claude.ai says "hostname doesn't resolve"** — Your tunnel isn't running or
the URL expired. Restart ngrok/tailscale.
