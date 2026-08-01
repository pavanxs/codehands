#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as readline from "node:readline";

const child = spawn("codehands", ["stdio", "--batch"], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: true,
});

const rl = readline.createInterface({ input: child.stdout });
const responses = [];

rl.on("line", (line) => {
  try {
    const parsed = JSON.parse(line);
    responses.push(parsed);
  } catch {}
});

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

// Initialize
send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
});

// Wait for init response, then list tools
setTimeout(() => {
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
}, 2000);

// Wait for tools list, check for batch
setTimeout(() => {
  const toolsResponse = responses.find(r => r.id === 2);
  if (toolsResponse) {
    const tools = toolsResponse.result.tools.map(t => t.name);
    console.log(`Total tools: ${tools.length}`);
    console.log(`Has batch: ${tools.includes("batch")}`);
    if (tools.includes("batch")) {
      console.log("SUCCESS: batch tool is exposed via stdio --batch");
    } else {
      console.log("FAIL: batch tool NOT in list");
      console.log("Tools:", tools.join(", "));
    }
  } else {
    console.log("No tools/list response received");
    console.log("Responses:", JSON.stringify(responses, null, 2));
  }
  child.kill();
  process.exit(0);
}, 5000);

child.on("error", (err) => {
  console.error("Spawn error:", err.message);
  process.exit(1);
});
