#!/usr/bin/env node

const LOCALHOST = "http://localhost:3100/mcp";
const TAILSCALE = "https://laptop-r118u60s.tail374fbf.ts.net/mcp";
const NGROK = process.env.NGROK_URL ? `${process.env.NGROK_URL}/mcp` : null;

const ITERATIONS = 10;

const initializePayload = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "latency-test", version: "1.0.0" },
  },
});

const toolsListPayload = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
});

async function measureRequest(url, payload, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const start = performance.now();
  try {
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

    return { elapsed, status: res.status, sessionId: sid, parsed, error: null };
  } catch (err) {
    const elapsed = performance.now() - start;
    return { elapsed, status: 0, sessionId: null, parsed: null, error: err.message };
  }
}

async function runLatencyTest(label, url) {
  console.log(`\n--- ${label} ---`);
  console.log(`URL: ${url}`);

  // Step 1: Initialize to get session ID
  const initResult = await measureRequest(url, initializePayload, null);
  if (initResult.error) {
    console.log(`  FAILED: ${initResult.error}`);
    return null;
  }

  const sessionId = initResult.sessionId;
  console.log(`  Initialize: ${initResult.elapsed.toFixed(1)}ms (session: ${sessionId?.slice(0, 8) ?? "none"})`);

  // Step 2: Measure tools/list latency (multiple iterations)
  const latencies = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const result = await measureRequest(url, toolsListPayload, sessionId);
    if (result.error) {
      console.log(`  Iteration ${i + 1}: FAILED - ${result.error}`);
    } else {
      latencies.push(result.elapsed);
    }
  }

  if (latencies.length === 0) {
    console.log("  No successful measurements.");
    return null;
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];

  console.log(`  Samples: ${latencies.length}/${ITERATIONS}`);
  console.log(`  Avg: ${avg.toFixed(1)}ms`);
  console.log(`  Min: ${min.toFixed(1)}ms`);
  console.log(`  Max: ${max.toFixed(1)}ms`);
  console.log(`  P50: ${p50.toFixed(1)}ms`);
  console.log(`  P95: ${p95.toFixed(1)}ms`);

  return { label, avg, min, max, p50, p95 };
}

async function main() {
  console.log("=== CodeHands Latency Test ===");
  console.log(`Iterations per endpoint: ${ITERATIONS}`);
  console.log(`Payload: tools/list (lightweight RPC call)`);

  const results = [];

  // Test localhost (direct, no tunnel)
  const localResult = await runLatencyTest("Localhost (direct)", LOCALHOST);
  if (localResult) results.push(localResult);

  // Test Tailscale
  const tailscaleResult = await runLatencyTest("Tailscale Funnel", TAILSCALE);
  if (tailscaleResult) results.push(tailscaleResult);

  // Test ngrok (if URL provided)
  if (NGROK) {
    const ngrokResult = await runLatencyTest("ngrok", NGROK);
    if (ngrokResult) results.push(ngrokResult);
  } else {
    console.log("\n--- ngrok ---");
    console.log("  Skipped (set NGROK_URL env var to test)");
    console.log("  Example: set NGROK_URL=https://abc123.ngrok.io");
  }

  // Summary table
  if (results.length > 0) {
    console.log("\n\n=== SUMMARY ===");
    console.log("┌─────────────────────┬────────┬────────┬────────┬────────┐");
    console.log("│ Endpoint            │ Avg    │ Min    │ P50    │ P95    │");
    console.log("├─────────────────────┼────────┼────────┼────────┼────────┤");
    for (const r of results) {
      const name = r.label.padEnd(19);
      console.log(
        `│ ${name} │ ${r.avg.toFixed(0).padStart(4)}ms │ ${r.min.toFixed(0).padStart(4)}ms │ ${r.p50.toFixed(0).padStart(4)}ms │ ${r.p95.toFixed(0).padStart(4)}ms │`
      );
    }
    console.log("└─────────────────────┴────────┴────────┴────────┴────────┘");

    if (results.length >= 2) {
      const overhead = results[1].avg - results[0].avg;
      console.log(
        `\nTunnel overhead: +${overhead.toFixed(1)}ms average vs localhost`
      );
    }
  }
}

main().catch(console.error);
