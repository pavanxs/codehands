# Codex adapter package

JSON-RPC client for the Codex exec-server.

Responsibilities:
- Spawns exec-server as a child process on startup
- Manages the JSON-RPC connection (send requests, receive responses)
- Auto-restarts exec-server on crash (up to 3 retries)
- Notifies connected clients when restarting

The exec-server provides: `fs/readFile`, `fs/writeFile`, `fs/createDirectory`,
`fs/readDirectory`, `fs/walk`, `fs/remove`, `fs/copy`, `fs/getMetadata`,
`process/start`, `process/read`, `process/write`, `process/terminate`,
`process/signal`.

No API key needed. Exec-server is purely local.
