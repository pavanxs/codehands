# Local agent

The local agent implements authenticated MCP Streamable HTTP and stdio
transports over one shared Codex exec-server.

HTTP defaults:

- `127.0.0.1:3100`
- bearer authentication from `~/.codehands/http-token`
- approved Host and Origin values
- 1 MiB request limit
- 120 requests per minute per peer
- 30-minute inactive-session expiry

Each MCP session has an independent active workspace, process ownership set,
audit history, and transport lifecycle. Closing a session terminates its
remaining processes and closes its audit stream.

Commands:

```text
codehands init
codehands doctor
codehands start
codehands stdio
codehands logs -f
```

The server performs a sandbox preflight against the first existing configured
workspace before opening the HTTP listener.

Set `CODEHANDS_CONFIG_DIR` to an absolute directory to isolate configuration,
tokens, and logs for tests or multiple local instances. Child processes receive
the active workspace as `HOME`/`USERPROFILE`; the real user home is not exposed
through the default sandbox.
