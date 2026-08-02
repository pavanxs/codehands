# ChatGPT Plugin Update Runbook

Use this runbook whenever CodeHands code or MCP tool metadata changes.

## The short answer

Updating the existing development plugin is deterministic. The normal loop is:

1. Build and test the current repository.
2. Restart the linked `codehands` server.
3. Verify the local and public endpoints.
4. In ChatGPT, select **Plugin actions → Manage → Refresh**.
5. Start a **new Chat conversation** from **Try in chat** and run a smoke test.

Do **not** uninstall and recreate the plugin for an ordinary code update.
Existing conversations can retain old tool metadata, so they are not a valid
refresh test.

## Current George's Mac registration

- Repository: `/Users/georgegood/Desktop/CodeHands`
- ChatGPT app: `CodeHands – Auto Shorts (Pavan)`
- Development app ID: `asdk_app_6a6dd969002c8191bd5c5974bc266ed9`
- Public MCP URL:
  `https://georges-macbook-pro-2.tail1dd25c.ts.net/mcp`
- Local port: read `port` from `~/.codehands/config.json` (currently `7310`)
- Authentication: none

If the plugin is deliberately recreated, ChatGPT will assign a new app ID.
Update this section in the same change.

## Normal update procedure

### 1. Confirm that the global command points to this checkout

```bash
command -v codehands
npm root -g
realpath "$(npm root -g)/@codehands/local-agent"
```

The final command must resolve to:

```text
/Users/georgegood/Desktop/CodeHands/apps/local-agent
```

If it does not, repair the one-time global link from the package directory:

```bash
cd /Users/georgegood/Desktop/CodeHands/apps/local-agent
npm link
```

Do not run a different clone, an old build directory, or yesterday's local
implementation.

### 2. Build and verify the repository

```bash
cd /Users/georgegood/Desktop/CodeHands
pnpm install               # required when dependencies or the lockfile changed
pnpm build
pnpm test
git diff --check
```

`codehands` executes `apps/local-agent/dist/cli.js`. Editing TypeScript without
running `pnpm build` leaves the running plugin on the old JavaScript.

### 3. Restart CodeHands and its Tailscale Funnel

Stop the existing CodeHands terminal with `Ctrl+C`, wait for `Shutting down...`,
then start it again:

```bash
cd /Users/georgegood/Desktop/CodeHands
codehands start --tunnel tailscale --batch
```

The restart is mandatory: a running Node process does not reload rebuilt files.

Do not run DevSpace's public Tailscale route at the same time. Both products can
run on the Mac, but only one should own the shared public Tailscale hostname
during a test. Do not use `tailscale down`, because that disables CodeHands too.

Useful routing checks:

```bash
pgrep -fl -i devspace
tailscale funnel status --json | jq -r '.. | .Proxy? // empty'
```

The Tailscale check must print the CodeHands listener, currently
`http://127.0.0.1:7310`. On this Mac the plain, non-JSON status command can say
`No serve config` while a foreground Funnel is active, so use the JSON form.

### 4. Verify CodeHands before touching ChatGPT

```bash
CODEHANDS_PORT="$(jq -r '.port' ~/.codehands/config.json)"
curl -fsS "http://localhost:${CODEHANDS_PORT}/health"
curl -fsS "https://georges-macbook-pro-2.tail1dd25c.ts.net/health"
curl -fsS -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"reload-check","version":"1.0"}}}' \
  "https://georges-macbook-pro-2.tail1dd25c.ts.net/mcp"
```

All three requests must succeed. If they do not, fix the build, server, or
Tailscale route first. Reinstalling the ChatGPT plugin cannot fix a dead public
endpoint.

### 5. Refresh the existing development plugin in ChatGPT

1. Open **Plugins**.
2. Open **CodeHands – Auto Shorts (Pavan)**.
3. Select **Plugin actions → Manage**.
4. Select **Refresh**.
5. Wait until the scan finishes and the **Refresh** button becomes enabled
   again.
6. Confirm that the expected tools are listed and that none advertises a UI
   resource or output template. With the current `--batch` startup there are 19
   CodeHands tools.

Use Refresh after every server code update. It is cheap, and it removes any
guesswork about whether ChatGPT rescanned the MCP metadata.

### 6. Test only in a fresh Chat conversation

1. Return to the CodeHands plugin page.
2. Select **Try in chat**.
3. Select the **Chat** surface, not **Work**.
4. Start the new conversation and send:

```text
Use CodeHands – Auto Shorts (Pavan) to call workspace_list exactly once.
Do not call any other CodeHands tool and do not modify anything. Quote the exact
approved workspace path returned by the tool; do not infer it.
```

Success means:

- the request appears in `~/.codehands/logs/YYYY-MM-DD.jsonl`;
- ChatGPT does not create a custom CodeHands widget or iframe; and
- ChatGPT quotes the exact workspace path returned in the tool result.

If ChatGPT cannot see and quote the workspace path, the model-visible
`structuredContent` payload is broken even when the underlying call succeeds.

The **Work** surface has intermittently failed to attach development plugins
even when the MCP endpoint is healthy. Do not use a Work failure as proof that
the refreshed server is broken.

## When uninstalling and reinstalling is justified

Use this only when all normal steps above succeeded and one of these is true:

- the MCP URL changed and the existing registration cannot be edited;
- the wrong or duplicate development app was installed;
- **Refresh** repeatedly fails even though direct public `/health` and `/mcp`
  checks succeed; or
- the ChatGPT development-app registration itself is corrupt.

### Last-resort reinstall procedure

1. Record the app name, MCP URL, and authentication setting above.
2. Open the exact old app and confirm its app ID before deleting anything.
3. Select **Plugin actions → Uninstall**. This is the ChatGPT “delete old one”
   operation; there is no corresponding CodeHands file to delete on the Mac.
4. Open **Plugins** and select **Create app**.
5. Enter:
   - **Name:** `CodeHands – Auto Shorts (Pavan)`
   - **Connection:** `Server URL`
   - **MCP Server URL:**
     `https://georges-macbook-pro-2.tail1dd25c.ts.net/mcp`
   - **Authentication:** no authentication
6. Acknowledge the custom-MCP-server warning and select **Create**.
7. Wait for discovery to finish and inspect the discovered tools. CodeHands
   should not advertise custom UI resources.
8. Use **Try in chat → Chat** and run the `workspace_list` smoke test above.
9. Replace the app ID in this runbook with the newly assigned ID.

Old chats can continue referencing the uninstalled app ID. Always test the new
registration in a fresh conversation.

## Why the process previously felt random

There are five independent layers that can each retain old state:

1. TypeScript source versus compiled `dist/` JavaScript.
2. The long-running Node server process.
3. The globally linked `codehands` command and the checkout it targets.
4. The Tailscale public route, especially when DevSpace uses the same hostname.
5. ChatGPT's development-plugin metadata, UI-resource, and conversation caches.

The normal procedure resets or verifies every layer in that order. Skipping a
layer makes a stale build look like an unpredictable ChatGPT problem.

## Fast troubleshooting order

Do not jump straight to reinstalling. Check in this order:

1. Global link points to this repository.
2. `pnpm build` and `pnpm test` pass.
3. CodeHands was restarted after the build.
4. Local `/health` succeeds.
5. The JSON Tailscale Funnel status points to the CodeHands port.
6. Public `/health` and `/mcp` succeed.
7. ChatGPT **Manage → Refresh** completes.
8. A fresh **Chat** conversation can call `workspace_list`.
9. Only then uninstall and recreate the app.
