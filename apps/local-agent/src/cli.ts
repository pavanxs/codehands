#!/usr/bin/env node

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer as createHttpServer } from "node:http";
import { loadConfig, initConfig, getConfigPath } from "./config.js";
import { createServer } from "./server.js";

const args = process.argv.slice(2);
const command = args[0];

async function runStart() {
  const config = loadConfig();

  if (config.workspaces.length === 0) {
    console.log(`⚠  No workspaces configured.`);
    console.log(`   Add project paths to: ${getConfigPath()}`);
    console.log(`   Example: { "workspaces": ["C:/Users/you/projects/my-app"] }`);
    console.log("");
  }

  const { server, adapter } = createServer(config);

  console.log(`Starting exec-server...`);
  await adapter.start();
  console.log(`exec-server ready.`);

  adapter.on("restarting", (attempt: number, max: number) => {
    console.log(`exec-server crashed, restarting (${attempt}/${max})...`);
  });

  adapter.on("failed", (err: Error) => {
    console.error(`exec-server failed permanently: ${err.message}`);
    process.exit(1);
  });

  adapter.on("stderr", (data: string) => {
    if (data.trim()) process.stderr.write(`[exec-server] ${data}`);
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
      return;
    }

    if (url.pathname === "/mcp") {
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await server.connect(transport);

  httpServer.listen(config.port, () => {
    console.log(`CodeHands MCP server running on http://localhost:${config.port}/mcp`);
    console.log(`Health check: http://localhost:${config.port}/health`);
    console.log(`Workspaces: ${config.workspaces.length > 0 ? config.workspaces.join(", ") : "(none)"}`);
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await adapter.stop();
    httpServer.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await adapter.stop();
    httpServer.close();
    process.exit(0);
  });
}

async function runStdio() {
  const config = loadConfig();
  const { server, adapter } = createServer(config);

  await adapter.start();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runInit() {
  const configPath = initConfig();
  console.log(`Config created at: ${configPath}`);
  console.log(`Edit this file to add your workspaces.`);
}

async function main() {
  switch (command) {
    case "start":
      await runStart();
      break;
    case "stdio":
      await runStdio();
      break;
    case "init":
      await runInit();
      break;
    default:
      console.log("CodeHands - MCP server for AI-powered coding");
      console.log("");
      console.log("Usage:");
      console.log("  codehands start    Start the HTTP MCP server");
      console.log("  codehands stdio    Run in stdio mode (for Claude Desktop)");
      console.log("  codehands init     Create default config file");
      console.log("");
      console.log(`Config: ${getConfigPath()}`);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
