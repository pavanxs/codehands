# Hosted gateway and remote access

## Current support

Direct public remote access is not supported in the pre-1.0 release.

Tailscale Funnel, ngrok, and Cloudflare Tunnel expose a local service to the
public internet. TLS protects traffic in transit, but a secret URL and a tunnel
are not application authentication.

CodeHands HTTP mode therefore:

- binds to `127.0.0.1` by default;
- requires a bearer token;
- rejects unapproved `Host` and `Origin` values;
- rate-limits requests and expires inactive sessions.

Do not add a Funnel/ngrok/Cloudflare hostname to `allowedHosts` and publish the
port directly.

## Local tailnet access

Tailscale Serve can make a service reachable only within a tailnet, unlike
Funnel. The MCP client must still send CodeHands' bearer token. This is useful
for a controlled native client but does not make a cloud-hosted ChatGPT web
session part of the tailnet.

## Required public design

A supported public deployment needs an MCP-compatible OAuth 2.1 gateway in
front of CodeHands:

```text
Web MCP client
  -> HTTPS + OAuth/PKCE gateway
  -> fixed upstream bearer credential
  -> CodeHands on loopback/private network
```

The gateway must provide:

- OAuth authorization-code flow with PKCE;
- exact redirect URI and client validation;
- short-lived, audience-bound access tokens;
- refresh-token rotation and revocation;
- rate limits and request-size limits;
- strict forwarding only to `/mcp`;
- no forwarding of arbitrary client authorization headers;
- security event logging without token values.

Until that component is implemented and reviewed, use stdio or authenticated
local HTTP.
