# Provider compatibility

Tool names and result schemas are provider-neutral.

## Local clients

- Streamable HTTP clients connect to the loopback endpoint with a bearer token.
- Stdio clients launch `codehands stdio`.

## Browser-hosted clients

ChatGPT and Claude web cannot reach localhost. Do not solve that by exposing
the local agent directly through a public tunnel. A supported deployment needs
the OAuth/PKCE gateway described in `hosted-gateway.md`.

Provider-specific authorization and connection instructions belong in the
gateway and documentation, not the policy/tool core.
