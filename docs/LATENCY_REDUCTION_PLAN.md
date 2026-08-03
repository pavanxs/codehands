# CodeHands Latency Reduction Plan

## Problem statement

A trivial local file read should complete in milliseconds, but ChatGPT-visible MCP calls currently take roughly 5–12 seconds each. Ten sequential reads can therefore take one to two minutes.

The dominant cost is not disk I/O. It is the end-to-end hosted tool loop:

```text
ChatGPT inference
  -> remote connector dispatch
  -> tunnel / public MCP endpoint
  -> CodeHands
  -> Codex exec-server
  -> local filesystem
  -> response through connector
  -> another ChatGPT inference before the next tool call
```

Removing a few milliseconds from local filesystem handling will not solve a multi-second hosted orchestration delay.

## Goal

Reduce latency while continuing to use inference included with a ChatGPT subscription, without requiring the user to manage or pay for an OpenAI API integration.

## Recommended architecture order

### Architecture A — Codex CLI + local CodeHands stdio (recommended first experiment)

```text
Codex CLI signed in with ChatGPT
  -> local MCP stdio
  -> CodeHands
  -> local workspace
```

This is the cleanest available local redirection path. Codex CLI runs locally, supports local MCP servers, and can be authenticated with the user's ChatGPT subscription.

Suggested Codex configuration in `%USERPROFILE%/.codex/config.toml`:

```toml
[mcp_servers.codehands]
type = "stdio"
command = "codehands"
args = ["stdio", "--batch"]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

For more reliable Windows process resolution, prefer an absolute command:

```toml
[mcp_servers.codehands]
type = "stdio"
command = "node"
args = [
  "D:/projects/mcp-coding-harness/apps/local-agent/dist/cli.js",
  "stdio",
  "--batch"
]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

Then launch Codex from the project root:

```powershell
cd D:\projects\mcp-coding-harness
codex
```

Use `/mcp` to verify that CodeHands is attached.

Why this should be faster:

- No Tailscale Funnel.
- No ChatGPT remote connector dispatch.
- No public MCP endpoint.
- Persistent local stdio transport.
- Codex itself runs the agent loop locally while using subscription-backed inference.

Important: avoid running CodeHands through Codex if Codex already has native filesystem and terminal tools for the same workspace. The purpose of this experiment is to benchmark the transport and preserve CodeHands policy/tool behavior, not to duplicate capabilities permanently.

### Architecture B — Codex Desktop + local CodeHands stdio

This has the desired desktop experience and local transport, but current Codex Desktop releases have reported regressions where MCP servers are discovered yet their tools are not mounted into active threads.

Treat Codex Desktop as a secondary target until the following checks pass:

- MCP appears in Settings.
- `/mcp` shows it inside the active thread.
- `tools/list` succeeds.
- CodeHands tools are actually callable by the model.

If Desktop fails while CLI succeeds, do not change CodeHands first. It is likely a Codex Desktop tool-injection/configuration problem.

### Architecture C — ChatGPT + current public connector, optimized

If the official ChatGPT interface must remain the client, a direct localhost redirect is not currently available. ChatGPT connector execution remains hosted.

Use the current route but optimize all controllable components:

```text
ChatGPT
  -> nearest stable HTTPS endpoint
  -> persistent CodeHands process
  -> persistent Codex exec-server
```

The tunnel choice alone is unlikely to remove the 5–12 second model/connector loop, but poor routing can add avoidable delay.

## Local redirection approaches

### 1. Direct stdio child process

Best local design:

```text
Local OpenAI client process
  -> spawn `codehands stdio --batch`
  -> communicate over stdin/stdout
```

Implementation already exists in `apps/local-agent/src/cli.ts` through `StdioServerTransport`.

No additional proxy is needed.

### 2. Local Streamable HTTP

For clients that support local HTTP:

```text
Client -> http://127.0.0.1:3100/mcp -> CodeHands
```

Recommended server change:

```ts
httpServer.listen(config.port, "127.0.0.1", () => {
  // existing startup logging
});
```

Use loopback explicitly. Do not use a tunnel for a client running on the same machine.

### 3. Local stdio-to-HTTP bridge

Only needed when a local client supports stdio but the server must remain shared over HTTP, or vice versa.

Possible bridge design:

```text
Client stdio
  -> thin local adapter
  -> persistent http://127.0.0.1:3100/mcp session
  -> CodeHands
```

The bridge must:

- Initialize one persistent MCP session.
- Preserve `Mcp-Session-Id`.
- Reuse HTTP keep-alive connections.
- Forward notifications and errors.
- Avoid launching a new CodeHands/Codex process per tool call.

Do not add this bridge unless a target client requires it. Direct stdio is simpler and faster.

### 4. Browser extension / localhost interception

Not recommended.

A browser extension cannot transparently redirect ChatGPT's server-side connector execution to the user's localhost. The connector call does not originate from the browser tab in the normal ChatGPT MCP architecture.

A local extension could create a separate UI and communicate with localhost, but then it becomes a new client rather than a redirect of ChatGPT's MCP connector.

### 5. Desktop traffic interception or reverse proxy

Not recommended and unlikely to work reliably.

Intercepting ChatGPT Desktop traffic does not move connector execution onto the machine. It also introduces certificate pinning, authentication, update breakage, and account-risk concerns.

## All controllable latency reductions

### P0 — Establish boundary timing

Add timing fields for every tool call:

```text
connector_received_at   (when visible, outside CodeHands)
server_received_at
handler_started_at
codex_rpc_sent_at
codex_rpc_received_at
serialization_done_at
response_finished_at
```

Record:

- `server_total_ms`
- `policy_ms`
- `codex_rpc_ms`
- `serialization_ms`
- `payload_bytes`
- `tool_name`
- `session_id`

Acceptance criterion:

A small local `fs_readFile` should report CodeHands internal latency below 50 ms on a warm process. If ChatGPT still shows several seconds, the remaining latency is outside CodeHands.

### P0 — Keep all processes warm

Verify that:

- CodeHands is started once.
- Codex exec-server is started once.
- The connector does not create a fresh CodeHands process per request.
- MCP sessions are reused.
- HTTP connections use keep-alive.

Add startup/session counters to logs to detect accidental respawning.

### P0 — Benchmark three routes

Use the same tiny file and run at least 30 reads per route:

1. Direct local CodeHands RPC / stdio benchmark.
2. Codex CLI with local stdio MCP.
3. ChatGPT through the existing tunnel.

Capture median, p90 and p99.

This separates CodeHands latency from client/orchestration latency.

### P0 — Use Codex CLI as the local subscription-backed client

Sign into Codex with the ChatGPT account and attach CodeHands over stdio.

Success criterion:

- MCP tool is callable locally.
- A tiny read is materially faster than the ChatGPT connector route.
- No API key is manually configured.

### P1 — Remove unnecessary local hops for read-only operations

Current read path:

```text
CodeHands -> local JSON-RPC -> Codex exec-server -> filesystem
```

Potential optimized path:

```text
CodeHands policy validation -> Node `fs.promises` -> filesystem
```

Candidate direct operations:

- `fs_readFile`
- `fs_readDirectory`
- `fs_getMetadata`
- `fs_walk`

Keep Codex for terminal/process and sandbox-sensitive mutations.

Expected saving: milliseconds, not seconds. Implement only after timing proves local RPC is significant.

### P1 — Remove avoidable serialization overhead

- Avoid pretty-printed JSON for tool results.
- Avoid Base64 for UTF-8 text when the internal protocol can safely return text.
- Return structured content where supported.
- Add byte and line limits to prevent oversized responses.
- Compress large remote HTTP responses only when payload size justifies CPU cost.

### P1 — Tune HTTP transport when ChatGPT remains the client

- Bind a stable process to one port.
- Use HTTP keep-alive.
- Reuse MCP sessions.
- Avoid proxy chains with multiple TLS terminations.
- Host the public edge geographically close to the OpenAI connector region when possible.
- Compare Tailscale Funnel, Cloudflare Tunnel, a small regional VPS reverse proxy, and OpenAI Secure MCP Tunnel using measured p50/p95, not assumptions.

A regional VPS relay can be tested as:

```text
ChatGPT -> regional HTTPS reverse proxy -> persistent WireGuard/Tailscale link -> CodeHands
```

This may improve network routing, but it will not remove hosted model/tool orchestration.

### P1 — Tune OpenAI Secure MCP Tunnel if tested

The official tunnel uses long-polling, bounded prefetch and configurable concurrent MCP workers.

Test:

- `control-plane.max-inflight`
- `mcp.max-concurrent-requests`
- persistent stdio binding rather than local HTTP
- tunnel client and CodeHands on the same host

This is useful for concurrent calls, but a single sequential tool call will still include the hosted connector lifecycle.

### P2 — Cache immutable/repeated reads

Cache key:

```text
absolute path + size + modification time
```

Return cached content when unchanged.

This helps repeated reads and large files but cannot eliminate remote orchestration latency.

### P2 — Reduce tool-manifest and schema overhead

- Expose only needed tools per mode.
- Keep descriptions concise.
- Avoid highly overlapping tools.
- Ensure `batch` is enabled only when needed but clearly discoverable.

This can reduce model selection overhead and incorrect sequential tool plans.

### P2 — Add connection diagnostics

Add a `latency_status` or `diagnostics` tool returning:

```json
{
  "serverUptimeMs": 0,
  "execServerUptimeMs": 0,
  "activeMcpSessions": 0,
  "execServerRestarts": 0,
  "lastCalls": [],
  "transport": "stdio|http",
  "host": "127.0.0.1",
  "version": "..."
}
```

## Proposed benchmark matrix

| Route | Inference entitlement | MCP location | Expected fixed overhead |
| --- | --- | --- | --- |
| ChatGPT + public tunnel | ChatGPT subscription | Remote connector to local server | Highest |
| ChatGPT + Secure MCP Tunnel | ChatGPT subscription | OpenAI queue/poller to local server | High |
| Codex Desktop + stdio | ChatGPT subscription | Local | Low when MCP mounting works |
| Codex CLI + stdio | ChatGPT subscription | Local | Lowest supported no-manual-API-key route |
| Direct local MCP benchmark | None | Local | Baseline only |

## Recommended execution order

1. Add instrumentation only.
2. Measure direct local CodeHands latency.
3. Configure Codex CLI with `codehands stdio --batch` using ChatGPT sign-in.
4. Compare 30 tiny reads against ChatGPT+tunnel.
5. Try Codex Desktop after CLI succeeds.
6. Compare public tunnel providers only if ChatGPT UI remains mandatory.
7. Optimize internal filesystem/RPC serialization only when measurements justify it.

## Definition of done

- Local warm `fs_readFile` p50 below 50 ms.
- Codex CLI local MCP p50 clearly separated from ChatGPT connector p50.
- No CodeHands or exec-server respawn per request.
- Timing logs identify at least 95% of end-to-end time by layer.
- A documented supported path exists for subscription-backed local inference through Codex CLI.
