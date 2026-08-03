# Provider compatibility

Active tool contracts and security scope are authoritative in [`CURRENT_PLAN.md`](./CURRENT_PLAN.md).

## Target providers

Both **ChatGPT** and **Claude Chat** are primary targets. The harness must work
with both from the start.

## Local clients

Local MCP clients connect via:
- **Streamable HTTP** — primary. Multiple clients connect to CodeHands' HTTP
  port on localhost. Low latency (~1-3ms).
- **stdio adapter** — for clients that only support stdio (e.g., Claude Desktop
  today). The adapter wraps the HTTP core internally.

## Browser-hosted clients (ChatGPT, Claude Chat)

Hosted chat applications cannot normally reach a machine on a user's local
network. CodeHands' HTTP port is exposed via any tunnel:
- **Recommended:** Tailscale with Funnel (free, private, no domain needed).
- **Alternatives:** Cloudflare Tunnel, ngrok, or any other tunnel.

The server is tunnel-agnostic. The current version assumes one trusted owner and that owner's agents. Built-in authentication, authorization, and remote-access hardening are deferred to a possible version 3; the current server must not be treated as a multi-user or untrusted public service.

Local and tunnel-based transports remain supported without changing the current global workspace/process model.

## Design rule

Keep MCP tool names and result schemas provider-neutral. Provider-specific
connection instructions belong in documentation, not in core business logic.
