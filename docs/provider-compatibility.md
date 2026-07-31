# Provider compatibility

Tool names and result schemas are provider-neutral.

## Local clients

- Streamable HTTP clients connect to the loopback endpoint with a bearer token.
- Stdio clients launch `codehands stdio`.

## Browser-hosted clients

ChatGPT and Claude web cannot reach localhost. For temporary single-user
testing, expose the local agent only through the capability URL described in
`hosted-gateway.md`. A shared or production deployment needs the OAuth/PKCE
gateway described there.

Provider-specific authorization and connection instructions belong in the
gateway and documentation, not the policy/tool core.
