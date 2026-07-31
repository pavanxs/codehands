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

1. Start CodeHands: `codehands start`
2. Expose via tunnel: `tailscale funnel 3100`
3. In ChatGPT settings → Connected Apps → Add MCP Server:
   - URL: `https://your-machine.tail12345.ts.net/mcp`
4. ChatGPT will discover all 16 tools automatically

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
