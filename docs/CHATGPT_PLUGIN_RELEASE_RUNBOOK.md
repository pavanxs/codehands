# ChatGPT Plugin Release and Verification Runbook

Use this runbook when CodeHands tool names, input schemas, output schemas, or runtime behavior change. Its purpose is to prevent testing a new source tree through an old running server or a stale ChatGPT snapshot.

## 1. Confirm the repository state

From the CodeHands repository root:

```powershell
git status --short
```

Review the working tree before building. Do not discard unrelated changes merely to prepare a plugin update.

## 2. Build and validate

```powershell
pnpm build
pnpm test
node tests/correctness-smoke.mjs
```

When HTTP behavior or MCP transport behavior changed, also run the live integration suite against an isolated test server or the final restarted server:

```powershell
node tests/integration.mjs
```

Do not proceed to snapshot work when the build or required tests fail.

## 3. Identify the server using port 3100

Stopping `codehands logs` does not stop the MCP server. Check the listening process explicitly:

```powershell
Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

Inspect the process when necessary:

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId = <PID>" |
  Select-Object ProcessId, ExecutablePath, CommandLine
```

## 4. Stop the old server

```powershell
$serverPid = Get-NetTCPConnection -LocalPort 3100 -State Listen |
  Select-Object -First 1 -ExpandProperty OwningProcess

Stop-Process -Id $serverPid -Force
```

Confirm that port 3100 is free:

```powershell
Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
```

The command should return nothing.

## 5. Start the newly built server

```powershell
codehands start --t tailscale --batch
```

Expected startup information includes the MCP URL, health URL, and whether the public `batch` tool is enabled. An `EADDRINUSE` message means another process still owns the configured port; do not start repeated copies.

## 6. Verify the running build before touching ChatGPT

Check local health:

```powershell
Invoke-RestMethod http://localhost:3100/health
```

Then verify the MCP surface with the repository integration test or another MCP client. Confirm at minimum:

- the intended tool count;
- exact tool names;
- current `inputSchema` fields;
- current `outputSchema` fields;
- a representative `tools/call` result;
- `structuredContent` matches the JSON text result.

A source-file inspection is not proof that the running process loaded that source. Verification must target the active endpoint.

## 7. Verify the remote endpoint

When ChatGPT connects through a tunnel, verify that the public health and MCP endpoints route to the same newly restarted local server. Avoid recording personal tunnel hostnames in repository documentation.

## 8. Refresh or recreate the ChatGPT snapshot

Use the current ChatGPT connector or plugin management interface to refresh the existing snapshot when it supports rediscovery. Recreate the snapshot when the management interface cannot refresh changed public tool names or schemas reliably.

Before saving the snapshot, verify that its discovered tool list matches the active endpoint exactly. Do not approve a snapshot that still shows an earlier singular input schema, an old tool count, or missing output schemas.

## 9. Test in a fresh conversation

Open a new ChatGPT conversation after the snapshot is refreshed or recreated. Existing conversations may retain earlier tool metadata.

Test at least:

1. `workspace_list` and `workspace_set`;
2. one multi-item filesystem call using `requests[]`;
3. `process_run` for a short command;
4. `process_start` followed by `process_read` for a long-running command;
5. one partial-failure result;
6. one continuation field;
7. `http_request`, including body truncation when relevant.

## 10. Diagnose a mismatch

When ChatGPT behavior does not match the repository, check these layers in order:

1. Was the repository rebuilt?
2. Is the old port-3100 process still running?
3. Does the local endpoint expose the new schemas?
4. Does the public tunnel route to that same process?
5. Was the ChatGPT snapshot refreshed or recreated after restart?
6. Is the test running in a new conversation?

Do not change implementation code solely to match evidence from an old server or stale snapshot.
