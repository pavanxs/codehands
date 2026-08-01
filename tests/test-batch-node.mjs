#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as readline from "node:readline";

// Exact same as config.toml: node with full path to cli.js
const child = spawn("node", [
  "C:\\Users\\Pavan\\AppData\\Roaming\\npm\\node_modules\\@codehands\\local-agent\\dist\\cli.js",
  "stdio",
  "--batch"
], {
  stdio: ["pipe", "pipe", "pipe"],
});

const rl = readline.createInterface({ input: child.stdout });
const responses = [];

child.stderr.on("data", (data) => {
  const msg = data.toString().trim();
  if (msg) console.error("[stderr]", msg);
});

rl.on("line", (line) => {
  try { responses.push(JSON.parse(line)); } catch {}
});

function send(msg) { child.stdin.write(JSON.stringify(msg) + "\n"); }

send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
});

setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), 3000);

setTimeout(() => {
  const toolsResp = responses.find(r => r.id === 2);
  if (toolsResp) {
    const tools = toolsResp.result.tools.map(t => t.name);
    console.log(`Tools: ${tools.length}`);
    console.log(`batch present: ${tools.includes("batch")}`);
  } else {
    console.log("No response. Got:", JSON.stringify(responses));
  }
  child.kill();
  process.exit(0);
}, 6000);
