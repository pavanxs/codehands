# Hosted gateway and remote access

## Current support

CodeHands supports a random capability URL for temporary, single-user remote
testing. Shared or production public access requires an OAuth gateway.

Tailscale Funnel, ngrok, and Cloudflare Tunnel expose a local service to the
public internet. TLS protects traffic in transit, but a tunnel alone is not
application authentication. CodeHands' capability path is the credential; it
contains a separately generated 256-bit random token.

CodeHands HTTP mode therefore:

- binds to `127.0.0.1` by default;
- requires a bearer token;
- rejects unapproved `Host` and `Origin` values;
- rate-limits requests and expires inactive sessions.

## Personal Tailscale Funnel testing

Keep the local server on loopback. In `~/.codehands/config.json`:

```json
{
  "host": "127.0.0.1",
  "auth": {
    "enabled": true,
    "tokenEnv": "CODEHANDS_AUTH_TOKEN"
  },
  "capabilityPath": {
    "enabled": true,
    "tokenEnv": "CODEHANDS_CAPABILITY_TOKEN"
  },
  "allowedHosts": [
    "localhost",
    "127.0.0.1",
    "::1",
    "machine.tail1234.ts.net"
  ]
}
```

Use the exact Funnel hostname, then start CodeHands and Funnel:

```bash
codehands doctor
codehands start
tailscale funnel --bg 3100
codehands capability-url machine.tail1234.ts.net
```

Add the printed HTTPS URL to the ChatGPT app definition. Do not add an
Authorization header: possession of the full capability URL authenticates that
route. Requests to `/mcp` still require the separate bearer token, and an
incorrect capability path returns `404`.

Safety requirements:

- keep the random token in `~/.codehands/capability-token` with private file
  permissions;
- allowlist only the exact Funnel hostname;
- do not share, log, commit, or screenshot the full URL;
- keep ChatGPT action approvals enabled;
- allowlist only the intended repository;
- stop Funnel when testing ends;
- run `codehands rotate-capability`, restart CodeHands, and update the ChatGPT
  app after any possible disclosure.

This is bearer authentication encoded in the URL, not OAuth. URLs can appear
in client, proxy, or service logs, so use it only for one trusted user and a
temporary test setup.

## Local tailnet access

Tailscale Serve can make a service reachable only within a tailnet, unlike
Funnel. The MCP client must still send CodeHands' bearer token. This is useful
for a controlled native client but does not make a cloud-hosted ChatGPT web
session part of the tailnet.

## Required shared or production design

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

Until that component is implemented and reviewed, do not use a capability URL
for shared or production access.
