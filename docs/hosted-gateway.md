# Hosted Gateway (Remote Access)

CodeHands already serves HTTP. To access it remotely (from phone, another
machine, or ChatGPT's web interface), expose port 3100 via a tunnel.

## Recommended: Tailscale Funnel

Free, private, no account sharing needed.

### Setup

1. Install Tailscale: https://tailscale.com/download
2. Enable Funnel for your machine:

```bash
tailscale funnel 3100
```

3. You'll get a public URL like `https://your-machine.tail12345.ts.net`
4. Use `https://your-machine.tail12345.ts.net/mcp` as the MCP endpoint

### Why Tailscale

- Free for personal use (up to 3 users)
- End-to-end encrypted
- No port forwarding needed
- Works behind NAT/firewalls
- You control access (approve devices in Tailscale admin)

## Alternative: Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:3100
```

Works but less control over who can access the URL.

## Alternative: ngrok

```bash
ngrok http 3100
```

Quick for testing. URL changes on restart (unless paid).

## Security Note

When exposing publicly, add auth middleware (v2 scope). For now, Tailscale's
device-level authentication is sufficient — only your approved devices can
reach the Funnel URL.
