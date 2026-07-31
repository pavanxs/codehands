#!/usr/bin/env node

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { CodexAdapter } from "@codehands/codex-adapter";
import { AuditLogger } from "@codehands/audit";
import { loadConfig, initConfig, getConfigPath, type CodehandsConfig } from "./config.js";
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

  const adapter = new CodexAdapter({ codexBinary: config.codexBinary });

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

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
      return;
    }

    if (url.pathname === "/mcp") {
      if (req.method === "POST") {
        await handlePost(req, res, config, adapter, transports);
      } else if (req.method === "GET") {
        await handleGet(req, res, transports);
      } else if (req.method === "DELETE") {
        await handleDelete(req, res, transports);
      } else {
        res.writeHead(405);
        res.end("Method not allowed");
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(config.port, () => {
    console.log(`CodeHands MCP server running on http://localhost:${config.port}/mcp`);
    console.log(`Health check: http://localhost:${config.port}/health`);
    console.log(`Workspaces: ${config.workspaces.length > 0 ? config.workspaces.join(", ") : "(none)"}`);
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    for (const [sid, t] of transports) {
      await t.close();
      transports.delete(sid);
    }
    await adapter.stop();
    httpServer.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    for (const [sid, t] of transports) {
      await t.close();
      transports.delete(sid);
    }
    await adapter.stop();
    httpServer.close();
    process.exit(0);
  });
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  config: CodehandsConfig,
  adapter: CodexAdapter,
  transports: Map<string, StreamableHTTPServerTransport>,
) {
  const body = await readBody(req);
  const parsed = JSON.parse(body);

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, parsed);
    return;
  }

  if (!sessionId && isInitializeRequest(parsed)) {
    const logger = new AuditLogger();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) transports.delete(sid);
    };

    const { server } = createServer(config, adapter, logger);
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
    return;
  }

  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: No valid session ID provided" },
    id: null,
  }));
}

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Map<string, StreamableHTTPServerTransport>,
) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.writeHead(400);
    res.end("Invalid or missing session ID");
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Map<string, StreamableHTTPServerTransport>,
) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.writeHead(400);
    res.end("Invalid or missing session ID");
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function runStdio() {
  const config = loadConfig();
  const adapter = new CodexAdapter({ codexBinary: config.codexBinary });
  await adapter.start();

  const { server } = createServer(config, adapter);
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
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\nError: ${message}`);
  process.exit(1);
});
