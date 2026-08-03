#!/usr/bin/env node

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { CodexAdapter } from "@codehands/codex-adapter";
import { AuditLogger } from "@codehands/audit";
import { loadConfig, initConfig, getConfigPath, addWorkspace, type CodehandsConfig } from "./config.js";
import { createServer } from "./server.js";

const args = process.argv.slice(2);
const command = args[0];
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

function parseTunnelFlag(): string | null {
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--tunnel" || args[i] === "--t") {
      return args[i + 1] ?? null;
    }
  }
  return null;
}

function hasBatchFlag(): boolean {
  return args.includes("--batch");
}

function startTailscaleFunnel(port: number): ChildProcess | null {
  try {
    execSync("tailscale version", { stdio: "ignore" });
  } catch {
    console.error("Error: tailscale is not installed or not in PATH.");
    console.error("Install from: https://tailscale.com/download");
    return null;
  }

  console.log(`Starting Tailscale Funnel on port ${port}...`);
  const child = spawn("tailscale", ["funnel", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (data: Buffer) => {
    const output = data.toString().trim();
    if (output) console.log(`[tailscale] ${output}`);
  });

  child.stderr?.on("data", (data: Buffer) => {
    const output = data.toString().trim();
    if (output) console.log(`[tailscale] ${output}`);
  });

  child.on("error", (err) => {
    console.error(`Tailscale Funnel error: ${err.message}`);
  });

  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`Tailscale Funnel exited with code ${code}`);
    }
  });

  try {
    const statusRaw = execSync("tailscale status --json", { encoding: "utf-8" });
    const status = JSON.parse(statusRaw);
    const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
    if (dnsName) {
      console.log(`Public MCP endpoint: https://${dnsName}/`);
      console.log(`Use this URL in ChatGPT/Claude.ai MCP settings.`);
    }
  } catch {
    console.log("(Could not determine public URL — check tailscale status)");
  }

  return child;
}

async function runStart() {
  let config = loadConfig();

  if (config.workspaces.length === 0) {
    console.log(`⚠  No workspaces configured.`);
    console.log(`   Add project paths to: ${getConfigPath()}`);
    console.log(`   Example: { "workspaces": ["C:/Users/you/projects/my-app"] }`);
    console.log("");
  }

  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    fs.watch(configPath, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        try {
          const updated = loadConfig();
          const added = updated.workspaces.filter((w) => !config.workspaces.includes(w));
          const removed = config.workspaces.filter((w) => !updated.workspaces.includes(w));
          config = updated;
          if (added.length > 0) console.log(`Config reloaded: +${added.length} workspace(s): ${added.join(", ")}`);
          if (removed.length > 0) console.log(`Config reloaded: -${removed.length} workspace(s): ${removed.join(", ")}`);
        } catch { /* ignore parse errors during editing */ }
      }, 300);
    });
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

  let tunnelProcess: ChildProcess | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => reject(error);
      httpServer.once("error", onError);
      httpServer.listen(config.port, () => {
        httpServer.off("error", onError);
        console.log(`CodeHands MCP server running on http://localhost:${config.port}/mcp`);
        console.log(`Health check: http://localhost:${config.port}/health`);
        console.log(`Workspaces: ${config.workspaces.length > 0 ? config.workspaces.join(", ") : "(none)"}`);
        if (hasBatchFlag()) console.log(`Batch tool: enabled`);

        const tunnelProvider = parseTunnelFlag();
        if (tunnelProvider === "tailscale") {
          tunnelProcess = startTailscaleFunnel(config.port);
        } else if (tunnelProvider) {
          console.error(`Unknown tunnel provider: "${tunnelProvider}". Supported: tailscale`);
        }
        resolve();
      });
    });
  } catch (error) {
    await adapter.stop().catch(() => undefined);
    const listenError = error as NodeJS.ErrnoException;
    if (listenError.code === "EADDRINUSE") {
      throw new Error(
        `Port ${config.port} is already in use. Stop the existing CodeHands server or change the port in ${getConfigPath()}.`,
      );
    }
    throw error;
  }

  const shutdown = async () => {
    console.log("\nShutting down...");
    if (tunnelProcess) {
      tunnelProcess.kill();
      tunnelProcess = null;
    }
    for (const [sid, t] of transports) {
      await t.close();
      transports.delete(sid);
    }
    await adapter.stop();
    httpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  config: CodehandsConfig,
  adapter: CodexAdapter,
  transports: Map<string, StreamableHTTPServerTransport>,
) {
  let parsed: unknown;
  try {
    const body = await readBody(req, MAX_REQUEST_BODY_BYTES);
    parsed = JSON.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "Request body too large" ? 413 : 400;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32700, message },
      id: null,
    }));
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, parsed);
    return;
  }

  if (!sessionId && isInitializeRequest(parsed)) {
    const logger = new AuditLogger();
    const newSessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) transports.delete(sid);
    };

    const features = { batch: hasBatchFlag() };
    const { server } = createServer(config, adapter, logger, newSessionId, features);
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

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    let tooLarge = false;

    req.on("data", (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) data += chunk.toString();
    });
    req.on("end", () => {
      if (tooLarge) reject(new Error("Request body too large"));
      else resolve(data);
    });
    req.on("error", reject);
  });
}

async function runStdio() {
  const config = loadConfig();
  const adapter = new CodexAdapter({ codexBinary: config.codexBinary });
  await adapter.start();

  const features = { batch: hasBatchFlag() };
  const { server } = createServer(config, adapter, undefined, undefined, features);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runInit() {
  const configPath = initConfig();
  console.log(`Config created at: ${configPath}`);
  console.log(`Edit this file to add your workspaces.`);
}

function runAdd() {
  const targetPath = args[1];
  if (!targetPath) {
    console.error("Usage: codehands add <path>");
    console.error("Example: codehands add D:\\projects\\my-app");
    process.exit(1);
  }

  const result = addWorkspace(targetPath);
  if (result.added) {
    console.log(`Added workspace: ${result.resolved}`);
    console.log(`(Server will pick it up on next start or reconnect)`);
  } else {
    console.error(`Could not add: ${result.reason}`);
    process.exit(1);
  }
}

function runConfig() {
  const configPath = getConfigPath();
  const platform = process.platform;

  let cmd: string;
  let cmdArgs: string[];

  if (platform === "win32") {
    cmd = "cmd.exe";
    cmdArgs = ["/c", "start", "", configPath];
  } else if (platform === "darwin") {
    cmd = "open";
    cmdArgs = ["-t", configPath];
  } else {
    const editor = process.env["EDITOR"] ?? process.env["VISUAL"] ?? "xdg-open";
    cmd = editor;
    cmdArgs = [configPath];
  }

  console.log(`Opening: ${configPath}`);
  spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" }).unref();
}

async function runDoctor() {
  let issues = 0;

  const ok = (msg: string) => console.log(`  [OK] ${msg}`);
  const fail = (msg: string) => { console.log(`  [!!] ${msg}`); issues++; };
  const warn = (msg: string) => console.log(`  [--] ${msg}`);

  console.log("CodeHands Doctor");
  console.log("================\n");

  // Check config file
  console.log("Config:");
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    ok(`Found: ${configPath}`);
    try {
      const config = loadConfig();
      ok(`Valid JSON, ${config.workspaces.length} workspace(s) configured`);

      // Check workspaces exist
      for (const ws of config.workspaces) {
        if (fs.existsSync(ws)) {
          ok(`Workspace exists: ${ws}`);
        } else {
          fail(`Workspace NOT found: ${ws}`);
        }
      }
      if (config.workspaces.length === 0) {
        warn("No workspaces configured yet. Run: codehands add <path>");
      }
    } catch (e) {
      fail(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    fail(`Config not found. Run: codehands init`);
  }

  // Check Codex exec-server
  console.log("\nExec-server:");
  try {
    const version = execSync("codex --version", { encoding: "utf-8", timeout: 5000 }).trim();
    ok(`codex found: ${version}`);
  } catch {
    fail("codex binary not found in PATH. Run: npm install -g @openai/codex");
  }

  // Check port
  console.log("\nNetwork:");
  try {
    const cfg = loadConfig();
    const portInUse = await new Promise<boolean>((resolve) => {
      const tester = net.createServer();
      tester.once("error", () => resolve(true));
      tester.once("listening", () => { tester.close(); resolve(false); });
      tester.listen(cfg.port);
    });
    if (portInUse) {
      ok(`Port ${cfg.port} is in use (server likely running)`);
    } else {
      ok(`Port ${cfg.port} is free (server not running)`);
    }
  } catch {
    warn("Could not check port");
  }

  // Check Tailscale
  console.log("\nTailscale (optional):");
  try {
    execSync("tailscale version", { stdio: "ignore", timeout: 5000 });
    ok("tailscale installed");
    try {
      const status = execSync("tailscale status --json", { encoding: "utf-8", timeout: 5000 });
      const parsed = JSON.parse(status);
      const dnsName = parsed.Self?.DNSName?.replace(/\.$/, "");
      if (dnsName) ok(`DNS: ${dnsName}`);
    } catch {
      warn("tailscale not connected");
    }
  } catch {
    warn("tailscale not installed (only needed for --tunnel)");
  }

  // Check Node.js version
  console.log("\nRuntime:");
  ok(`Node.js ${process.version}`);
  ok(`Platform: ${process.platform} ${process.arch}`);

  console.log(`\n${issues === 0 ? "All checks passed." : `${issues} issue(s) found.`}`);
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
    case "add":
      runAdd();
      break;
    case "config":
      runConfig();
      break;
    case "doctor":
      await runDoctor();
      break;
    case "logs": {
      const { runLogs } = await import("./logs.js");
      await runLogs();
      break;
    }
    default:
      console.log("CodeHands - MCP server for AI-powered coding");
      console.log("");
      console.log("Usage:");
      console.log("  codehands start                     Start the HTTP MCP server");
      console.log("  codehands start --batch             Start with batch tool enabled");
      console.log("  codehands start --tunnel tailscale  Start with Tailscale Funnel");
      console.log("  codehands stdio                     Run in stdio mode (for Claude/ChatGPT Desktop)");
      console.log("  codehands stdio --batch             Stdio mode with batch tool");
      console.log("  codehands init                      Create default config file");
      console.log("  codehands add <path>                Add a workspace to config");
      console.log("  codehands config                    Open config in editor");
      console.log("  codehands doctor                    Check system health");
      console.log("  codehands logs                      Follow live MCP calls in readable grouped entries");
      console.log("");
      console.log("Flags:");
      console.log("  --batch                Enable batch tool (run multiple tools in one call)");
      console.log("  --tunnel <provider>    Start tunnel (tailscale)");
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
