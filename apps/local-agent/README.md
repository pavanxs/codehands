# Local agent (CodeHands server)

The main CodeHands process. This is the MCP server that web AIs connect to.

Architecture:
- **HTTP core (Streamable HTTP):** Primary transport. Handles multiple
  simultaneous AI client connections. Serves on localhost for local mode.
  Same port exposed via tunnel for hosted mode.
- **stdio adapter:** Thin wrapper for stdio-only clients (e.g., Claude Desktop).
  Connects internally to the HTTP core.
- **exec-server management:** Spawns Codex exec-server on startup, manages its
  lifecycle, handles auto-restart.

Startup: `codehands start`
- Spawns exec-server as a child process
- Starts HTTP server on configured port
- Ready to accept MCP connections

No implementation has been added yet.
