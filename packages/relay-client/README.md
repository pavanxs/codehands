# Relay client package

Tunnel integration utilities for hosted mode.

Design is tunnel-agnostic — CodeHands just serves HTTP; any tunnel can expose
the port. This package provides:
- Tunnel health checks
- Connection status utilities
- Documentation/guides for setting up Tailscale Funnel (recommended),
  Cloudflare Tunnel, ngrok, etc.

Auth for hosted mode is v2.
