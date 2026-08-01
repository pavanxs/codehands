#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as readline from "node:readline";

const child = spawn("node", [
  "C:\\Users\\Pavan\\AppData\\Roaming\\npm\\node_modules\\@codehands\\local-agent\\dist\\cli.js",
  "stdio", "--batch"
], { stdio: ["pipe", "pipe", "pipe"] });

const rl = readline.createInterface({ input: child.stdout });
const responses = [];
rl.on("line", (line) => { try { responses.push(JSON.parse(line)); } catch {} });

function send(msg) { child.stdin.write(JSON.stringify(msg) + "\n"); }

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } });

setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), 2000);

setTimeout(() => {
  const toolsResp = responses.find(r => r.id === 2);
  if (toolsResp) {
    const tools = toolsResp.result.tools;
    const fullJson = JSON.stringify(tools);
    
    // Rough token estimate: ~4 chars per token for JSON
    const charCount = fullJson.length;
    const estimatedTokens = Math.ceil(charCount / 4);
    
    console.log(`Tools: ${tools.length}`);
    console.log(`Total schema chars: ${charCount}`);
    console.log(`Estimated tokens: ~${estimatedTokens}`);
    console.log(`ChatGPT limit: 5000 tokens`);
    console.log(`Status: ${estimatedTokens < 5000 ? "WITHIN limit" : "OVER limit!"}`);
    console.log("");
    
    // Per-tool breakdown
    for (const tool of tools) {
      const toolJson = JSON.stringify(tool);
      console.log(`  ${tool.name}: ${toolJson.length} chars (~${Math.ceil(toolJson.length / 4)} tokens)`);
    }
  }
  child.kill();
  process.exit(0);
}, 5000);
