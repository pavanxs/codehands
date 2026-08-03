# GitHub Issue Draft: Add a subscription-backed local MCP path and end-to-end latency instrumentation

## Title

Add local Codex stdio setup and latency diagnostics to avoid multi-second remote connector overhead

## Summary

CodeHands local filesystem operations are fast, but calls made through ChatGPT's remote MCP connector can take approximately 5–12 seconds per tool invocation. Repository analysis that requires ten sequential reads can therefore take one to two minutes.

The project needs:

1. A documented local MCP route using Codex CLI signed in with a ChatGPT subscription.
2. End-to-end timing instrumentation that separates CodeHands/Codex latency from hosted connector latency.
3. Transport diagnostics that detect process respawns, session recreation and connection reuse failures.

This issue is intentionally not about adding higher-level repository tools or more batching. Those are separate improvements. This issue focuses on reducing and accurately locating transport/orchestration latency.

## Current architecture

```text
ChatGPT inference
  -> hosted connector
  -> tunnel/public MCP endpoint
  -> CodeHands Streamable HTTP
  -> Codex exec-server over stdio
  -> local filesystem
```

Observed behavior:

- Tiny file reads can take multiple seconds from ChatGPT.
- Ten sequential reads can take around two minutes.
- Local disk access should not account for this delay.
- Existing `batch` helps when the model chooses it, but does not solve single-call fixed overhead.

## Proposed local architecture

```text
Codex CLI signed in with ChatGPT
  -> CodeHands MCP over local stdio
  -> local workspace
```

This route uses subscription-backed Codex inference and does not require the user to manually configure an OpenAI API key.

Suggested configuration:

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

## Tasks

### P0 — Documentation

- [ ] Add `docs/codex-local-setup.md`.
- [ ] Explain ChatGPT sign-in for Codex CLI.
- [ ] Add Windows global and absolute-path configurations.
- [ ] Explain how to verify the server with `/mcp`.
- [ ] Document that Codex Desktop currently has reported MCP mounting/config regressions and that CLI is the initial reliable target.
- [ ] Correct any documentation implying that the ChatGPT Desktop app directly supports local stdio MCP servers.

### P0 — Per-call timing

- [ ] Generate a correlation ID for every MCP tool call.
- [ ] Record request receipt time.
- [ ] Record policy validation duration.
- [ ] Record Codex RPC send and response times.
- [ ] Record serialization duration.
- [ ] Record response completion time.
- [ ] Record payload bytes.
- [ ] Record transport type and MCP session ID.
- [ ] Include timing data in structured logs.

Suggested log shape:

```json
{
  "correlationId": "call-...",
  "tool": "fs_readFile",
  "transport": "stdio",
  "sessionId": "...",
  "policyMs": 1,
  "codexRpcMs": 4,
  "serializationMs": 1,
  "serverTotalMs": 8,
  "requestBytes": 82,
  "responseBytes": 2310,
  "success": true
}
```

### P0 — Process lifecycle diagnostics

- [ ] Track CodeHands startup time and uptime.
- [ ] Track Codex exec-server startup time and uptime.
- [ ] Count exec-server restarts.
- [ ] Count MCP sessions created and closed.
- [ ] Log when a new Codex child process is spawned.
- [ ] Verify that no child process is spawned for each tool call.

### P0 — Benchmark harness

- [ ] Add a read-only benchmark script.
- [ ] Benchmark a tiny warm file at least 30 times.
- [ ] Report p50, p90 and p99.
- [ ] Benchmark direct CodeHands stdio.
- [ ] Benchmark local HTTP on `127.0.0.1`.
- [ ] Document a manual Codex CLI measurement procedure.
- [ ] Document a manual ChatGPT connector measurement procedure.

Benchmark output example:

```text
route=direct-stdio tool=fs_readFile n=30 p50=8ms p90=14ms p99=22ms
route=localhost-http tool=fs_readFile n=30 p50=12ms p90=21ms p99=33ms
route=chatgpt-tunnel tool=fs_readFile n=30 p50=6200ms p90=10400ms p99=12800ms
```

### P1 — HTTP connection efficiency

- [ ] Bind local mode explicitly to `127.0.0.1`.
- [ ] Confirm HTTP keep-alive is enabled and reused.
- [ ] Add counters for TCP connections and MCP sessions.
- [ ] Avoid recreating sessions for normal sequential calls.
- [ ] Add clean JSON parse errors and body-size limits.

### P1 — Optional direct read path

Only after instrumentation shows the local Codex RPC hop is significant:

- [ ] Prototype direct Node filesystem reads after the same workspace policy validation.
- [ ] Compare direct Node reads against Codex exec-server reads.
- [ ] Preserve Codex for process execution and sandbox-sensitive operations.
- [ ] Do not merge if the gain is negligible relative to complexity.

### P1 — Payload efficiency

- [ ] Stop pretty-printing large JSON tool responses.
- [ ] Avoid Base64 for UTF-8 text where the internal protocol permits it.
- [ ] Add maximum response bytes and truncation metadata.
- [ ] Record token/payload size correlation where observable.

### P2 — Tunnel comparison

- [ ] Create a repeatable test for Tailscale Funnel.
- [ ] Test OpenAI Secure MCP Tunnel.
- [ ] Optionally test Cloudflare Tunnel or a regional reverse proxy.
- [ ] Measure p50/p95 rather than relying on subjective impressions.
- [ ] Separate connector/model time from network time whenever possible.

## Non-goals

- Adding `fs_readMany`.
- Adding repository search/context tools.
- Changing the batching design.
- Building an API-based custom chat client.
- Using browser interception or certificate/proxy hacks to redirect ChatGPT connector traffic.

## Why not browser or desktop interception?

ChatGPT's MCP connector execution is hosted. Redirecting browser requests to localhost does not move the connector tool invocation onto the user's machine. A browser extension could create a separate local tool UI, but that would be a different client, not transparent ChatGPT MCP redirection.

## Acceptance criteria

- [ ] Warm local `fs_readFile` p50 is below 50 ms.
- [ ] Logs explain where at least 95% of CodeHands-side time is spent.
- [ ] CodeHands and Codex exec-server remain persistent across tool calls.
- [ ] Codex CLI can discover and invoke CodeHands through local stdio.
- [ ] The setup uses ChatGPT account sign-in rather than a manually supplied API key.
- [ ] Documentation clearly distinguishes ChatGPT remote MCP from Codex local MCP.
- [ ] A benchmark table compares local stdio, local HTTP and the current ChatGPT connector route.

## External constraints

- The ChatGPT app does not currently connect directly to localhost MCP servers.
- OpenAI Secure MCP Tunnel still traverses OpenAI's hosted tunnel service and uses a poll/response lifecycle.
- Codex CLI supports local operation and ChatGPT account sign-in.
- Codex Desktop has active reports where MCP servers are discovered but their tools are not injected into desktop threads; verify CLI first.
