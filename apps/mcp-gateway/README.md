# MCP gateway (hosted mode)

Hosted access to CodeHands from anywhere (phone, tablet, any browser).

In practice, the gateway IS the same HTTP server from `apps/local-agent` — its
port just gets exposed publicly via a tunnel. This package provides:
- Tunnel integration and configuration
- Auth middleware (v2)
- Connection guides for ChatGPT and Claude Chat

Recommended tunnel: Tailscale with Funnel (free, private, no domain).
Alternatives: Cloudflare Tunnel, ngrok.

V1 scope. No implementation has been added yet.
