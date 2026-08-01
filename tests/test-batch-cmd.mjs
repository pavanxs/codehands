#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as readline from "node:readline";

// Simulate how ChatGPT Desktop would launch .cmd on Windows:
// It likely uses cmd.exe /c to run the .cmd file
const child = spawn("cmd.exe", ["/c", "codehands", "stdio", "--batch"], {
  stdio: ["pipe", "pipe", "pipe"],
});

const rl = readline.createInterface({ input: child.stdout });
const responses = [];

child.stderr.on("data", (data) => {
  console.error("[stderr]", data.toString());
});

rl.on("line", (line) => {
  try {
    const parsed = JSON.parse(line);
    responses.push(parsed);
  } catch {}
});

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
});

setTimeout(() => {
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
}, 3000);

setTimeout(() => {
  const toolsResponse = responses.find(r => r.id === 2);
  if (toolsResponse) {
    const tools = toolsResponse.result.tools.map(t => t.name);
    console.log(`Total tools: ${tools.length}`);
    console.log(`Has batch: ${tools.includes("batch")}`);
    if (tools.includes("batch")) {
      console.log("\nSUCCESS: batch is exposed");
    } else {
      console.log("\nFAIL: batch not in list. Tools:");
      tools.forEach(t => console.log(`  - ${t}`));
    }
  } else {
    console.log("No tools/list response");
    console.log("All responses:", JSON.stringify(responses, null, 2));
  }
  child.kill();
  process.exit(0);
}, 6000);

child.on("error", (err) => {
  console.error("Spawn error:", err.message);
  process.exit(1);
});
