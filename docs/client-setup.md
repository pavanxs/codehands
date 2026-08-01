# Connecting AI Clients to CodeHands

## Claude Desktop (Local — stdio mode)

1. Open Claude Desktop settings
2. Edit `claude_desktop_config.json`:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`

3. Add this MCP server entry:

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

4. Restart Claude Desktop
5. CodeHands tools will appear in Claude's tool list

## Claude Desktop (Local — HTTP mode)

If you prefer HTTP (allows multiple clients):

1. Start the server: `codehands start`
2. In Claude Desktop config:

```json
{
  "mcpServers": {
    "codehands": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

## ChatGPT (Web — Remote via tunnel)

ChatGPT's web interface uses Remote MCP, so you need a public URL.

1. Start CodeHands with its tunnel:
   `codehands start --tunnel tailscale`
2. In ChatGPT, open **Plugins → Create app**.
3. Enter a name, select **Server URL**, and use:
   `https://your-machine.tail12345.ts.net/mcp`
4. Select no authentication, acknowledge the custom-server warning, and
   select **Create**.
5. ChatGPT will discover the current 18 tools automatically (19 when CodeHands
   is started with `--batch`).

For subsequent code or tool-metadata changes, do not recreate the app. Follow
the [`ChatGPT Plugin Update Runbook`](chatgpt-plugin-update-runbook.md) to
rebuild, restart, refresh the existing development registration, and verify it
in a fresh Chat conversation.

## Any MCP Client (Generic)

CodeHands exposes a standard MCP Streamable HTTP endpoint:

- **URL:** `http://localhost:3100/mcp`
- **Protocol:** MCP 2024-11-05
- **Transport:** Streamable HTTP (POST for requests, SSE for responses)
- **Health check:** `GET http://localhost:3100/health`

### Quick test with curl:

```bash
curl -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

## First Use

After connecting any client, the AI needs to:

1. Call `workspace_list` to see approved projects
2. Call `workspace_set` to pick a project
3. Then use any file/process tool with relative paths
