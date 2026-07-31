# MCP OAuth gateway

Reserved for a future reviewed OAuth 2.1/PKCE gateway for browser-hosted MCP
clients.

The local agent must not be exposed directly through Tailscale Funnel, ngrok,
Cloudflare Tunnel, or a public reverse proxy. Those products can provide HTTPS
reachability but do not implement the application authorization required here.

The gateway is not implemented. Until it is, supported transports are stdio
and bearer-authenticated HTTP on loopback/private infrastructure.

See `docs/hosted-gateway.md` for the minimum security contract.
