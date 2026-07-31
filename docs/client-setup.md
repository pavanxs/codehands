# Connecting MCP clients

Run this before connecting a client:

```bash
codehands doctor
```

## Local stdio

For a client that can launch a local MCP server:

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

Restart the client after saving its configuration.

## Authenticated local HTTP

Start the server:

```bash
codehands start
```

The endpoint is `http://127.0.0.1:3100/mcp`. HTTP clients must read the bearer
token from `~/.codehands/http-token` and send:

```text
Authorization: Bearer <token>
```

Do not paste the token into a chat or commit it to a repository.

Example initialization request:

```bash
TOKEN="$(cat "$HOME/.codehands/http-token")"
curl http://127.0.0.1:3100/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

On Windows PowerShell:

```powershell
$token = (Get-Content "$HOME\.codehands\http-token").Trim()
$headers = @{
  Authorization = "Bearer $token"
  Accept = "application/json, text/event-stream"
}
```

## ChatGPT web and other cloud MCP clients

For temporary, single-user testing, enable `capabilityPath` and expose the
loopback server through an HTTPS tunnel as described in
[hosted-gateway.md](hosted-gateway.md). ChatGPT receives a URL shaped like:

```text
https://machine.tail1234.ts.net/<random-256-bit-capability>/mcp
```

The full URL is a credential. Do not paste it into a chat, commit it, include
it in screenshots, or reuse it after accidental disclosure. The ordinary
`/mcp` route remains bearer-protected.

Cloud MCP client requirements vary. Use an OAuth gateway for shared,
multi-user, or production access.

## First tool calls

1. Call `workspace_list`.
2. Call `workspace_set` with an exact returned path or an unambiguous name.
3. Use relative paths for subsequent file and Git tools.
4. Pass commands as executable plus argument array, for example
   `{"command":"npm","args":["test"]}`.
5. Call `activity_recent` when diagnosing latency or a failure.

The active workspace and process handles belong only to that MCP session.
