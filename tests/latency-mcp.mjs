#!/usr/bin/env node

const LOCALHOST = "http://localhost:3100/mcp";
const TAILSCALE = "https://laptop-r118u60s.tail374fbf.ts.net/mcp";

const ITERATIONS = 5;

function rpcCall(method, params, id) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function toolCall(name, args, id) {
  return rpcCall("tools/call", { name, arguments: args }, id);
}

async function sendRequest(url, payload, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const start = performance.now();
  const res = await fetch(url, { method: "POST", headers, body: payload });
  const text = await res.text();
  const elapsed = performance.now() - start;

  const sid = res.headers.get("mcp-session-id");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const jsonLine = text.split("\n").find((l) => l.startsWith("data: "));
    if (jsonLine) parsed = JSON.parse(jsonLine.slice(6));
  }

  return { elapsed, sessionId: sid, parsed, status: res.status };
}

async function initSession(url) {
  const payload = rpcCall("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "latency-mcp-test", version: "1.0.0" },
  }, 0);
  const result = await sendRequest(url, payload, null);
  return result.sessionId;
}

async function measureToolCall(url, sessionId, toolName, args, label) {
  const latencies = [];
  let lastResult = null;

  for (let i = 0; i < ITERATIONS; i++) {
    const payload = toolCall(toolName, args, i + 10);
    const result = await sendRequest(url, payload, sessionId);
    latencies.push(result.elapsed);
    lastResult = result.parsed;
  }

  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);

  return { label, toolName, avg, min, max, latencies, lastResult };
}

async function runFullTest(label, url) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  ${label}`);
  console.log(`  ${url}`);
  console.log(`${"=".repeat(50)}`);

  const sessionId = await initSession(url);
  if (!sessionId) {
    console.log("  FAILED to initialize session");
    return [];
  }
  console.log(`  Session: ${sessionId.slice(0, 8)}...\n`);

  const results = [];

  // 1. workspace_list (lightweight, no disk I/O)
  const wsListResult = await measureToolCall(url, sessionId, "workspace_list", {}, "workspace_list");
  results.push(wsListResult);
  console.log(`  workspace_list:    avg ${wsListResult.avg.toFixed(1)}ms  (min ${wsListResult.min.toFixed(1)}, max ${wsListResult.max.toFixed(1)})`);

  // 2. workspace_set (sets active workspace)
  const wsSetResult = await measureToolCall(url, sessionId, "workspace_set", { workspace: "D:\\projects\\mcp-coding-harness" }, "workspace_set");
  results.push(wsSetResult);
  console.log(`  workspace_set:     avg ${wsSetResult.avg.toFixed(1)}ms  (min ${wsSetResult.min.toFixed(1)}, max ${wsSetResult.max.toFixed(1)})`);

  // 3. fs_readDirectory (reads disk, returns entries)
  const readDirResult = await measureToolCall(url, sessionId, "fs_readDirectory", { path: "." }, "fs_readDirectory");
  results.push(readDirResult);
  console.log(`  fs_readDirectory:  avg ${readDirResult.avg.toFixed(1)}ms  (min ${readDirResult.min.toFixed(1)}, max ${readDirResult.max.toFixed(1)})`);

  // 4. fs_readFile (reads actual file content)
  const readFileResult = await measureToolCall(url, sessionId, "fs_readFile", { path: "package.json" }, "fs_readFile");
  results.push(readFileResult);
  console.log(`  fs_readFile:       avg ${readFileResult.avg.toFixed(1)}ms  (min ${readFileResult.min.toFixed(1)}, max ${readFileResult.max.toFixed(1)})`);

  // 5. fs_getMetadata (stat a file)
  const metaResult = await measureToolCall(url, sessionId, "fs_getMetadata", { path: "package.json" }, "fs_getMetadata");
  results.push(metaResult);
  console.log(`  fs_getMetadata:    avg ${metaResult.avg.toFixed(1)}ms  (min ${metaResult.min.toFixed(1)}, max ${metaResult.max.toFixed(1)})`);

  // 6. process_start (start echo command)
  const procStartResult = await measureToolCall(url, sessionId, "process_start", { command: "echo latency-test" }, "process_start");
  results.push(procStartResult);
  console.log(`  process_start:     avg ${procStartResult.avg.toFixed(1)}ms  (min ${procStartResult.min.toFixed(1)}, max ${procStartResult.max.toFixed(1)})`);

  // 7. process_list (check running processes)
  const procListResult = await measureToolCall(url, sessionId, "process_list", {}, "process_list");
  results.push(procListResult);
  console.log(`  process_list:      avg ${procListResult.avg.toFixed(1)}ms  (min ${procListResult.min.toFixed(1)}, max ${procListResult.max.toFixed(1)})`);

  // 8. wait (100ms wait - baseline)
  const waitResult = await measureToolCall(url, sessionId, "wait", { ms: 100 }, "wait(100ms)");
  results.push(waitResult);
  console.log(`  wait(100ms):       avg ${waitResult.avg.toFixed(1)}ms  (min ${waitResult.min.toFixed(1)}, max ${waitResult.max.toFixed(1)})`);

  return results;
}

async function main() {
  console.log("=== CodeHands MCP Tool Call Latency Test ===");
  console.log(`Iterations per tool: ${ITERATIONS}`);
  console.log(`Testing real MCP tool calls (not just metadata)`);

  const localResults = await runFullTest("LOCALHOST (direct)", LOCALHOST);
  const tailscaleResults = await runFullTest("TAILSCALE FUNNEL", TAILSCALE);

  // Comparison table
  console.log(`\n\n${"=".repeat(60)}`);
  console.log("  COMPARISON: Localhost vs Tailscale (avg ms)");
  console.log(`${"=".repeat(60)}`);
  console.log("┌───────────────────┬────────────┬────────────┬──────────┐");
  console.log("│ Tool Call         │ Localhost  │ Tailscale  │ Overhead │");
  console.log("├───────────────────┼────────────┼────────────┼──────────┤");

  for (let i = 0; i < localResults.length; i++) {
    const local = localResults[i];
    const ts = tailscaleResults[i];
    if (!local || !ts) continue;
    const overhead = ts.avg - local.avg;
    const sign = overhead >= 0 ? "+" : "";
    const name = local.label.padEnd(17);
    console.log(
      `│ ${name} │ ${local.avg.toFixed(1).padStart(7)}ms │ ${ts.avg.toFixed(1).padStart(7)}ms │ ${(sign + overhead.toFixed(1)).padStart(6)}ms │`
    );
  }

  console.log("└───────────────────┴────────────┴────────────┴──────────┘");

  const localAvgAll = localResults.reduce((s, r) => s + r.avg, 0) / localResults.length;
  const tsAvgAll = tailscaleResults.reduce((s, r) => s + r.avg, 0) / tailscaleResults.length;
  console.log(`\n  Overall average: Localhost ${localAvgAll.toFixed(1)}ms, Tailscale ${tsAvgAll.toFixed(1)}ms`);
  console.log(`  Average tunnel overhead: ${(tsAvgAll - localAvgAll).toFixed(1)}ms per tool call`);
}

main().catch(console.error);
