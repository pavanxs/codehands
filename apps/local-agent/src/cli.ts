#!/usr/bin/env node

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { CodexAdapter, createWorkspaceSandbox } from "@codehands/codex-adapter";
import { AuditLogger } from "@codehands/audit";
import {
  loadConfig,
  initConfig,
  getConfigPath,
  getTokenPath,
  getCapabilityTokenPath,
  ensureTokenFile,
  ensureCapabilityTokenFile,
  rotateCapabilityTokenFile,
  isValidCapabilityToken,
  type CodehandsConfig,
} from "./config.js";
import { createServer } from "./server.js";
import {
  authorizeHttpRequest,
  FixedWindowRateLimiter,
  isCapabilityPath,
  sendHttpError,
} from "./http-security.js";

const args = process.argv.slice(2);
const command = args[0];

async function runStart() {
  let config = loadConfig();
  if (config.auth.enabled && !config.authToken) {
    ensureTokenFile();
    config = loadConfig();
  }
  if (config.capabilityPath.enabled && !config.capabilityToken) {
    ensureCapabilityTokenFile();
    config = loadConfig();
  }
  assertCapabilityToken(config);

  if (config.workspaces.length === 0) {
    console.log(`⚠  No workspaces configured.`);
    console.log(`   Add project paths to: ${getConfigPath()}`);
    console.log(`   Example: { "workspaces": ["C:/Users/you/projects/my-app"] }`);
    console.log("");
  }

  const adapter = new CodexAdapter({ codexBinary: config.codexBinary });

  console.log(`Starting exec-server...`);
  await adapter.start();
  const preflightWorkspace = config.workspaces.find((workspace) => fs.existsSync(workspace));
  if (preflightWorkspace) {
    const sandboxType = await verifySandbox(adapter, preflightWorkspace);
    console.log(`Sandbox ready (${sandboxType}).`);
  }
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

  const transports = new Map<string, ManagedTransport>();
  const limiter = new FixedWindowRateLimiter(config.rateLimitPerMinute);

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${config.host}:${config.port}`);

      if (url.pathname === "/health") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
        return;
      }

      const capabilityRequest = isCapabilityPath(url.pathname, config);
      if (url.pathname === "/mcp" || capabilityRequest) {
        const authorization = authorizeHttpRequest(
          req,
          config,
          limiter,
          capabilityRequest ? "capability" : "bearer",
        );
        if (!authorization.allowed) {
          sendHttpError(res, authorization.status, authorization.message);
          return;
        }

        if (req.method === "POST") {
          await handlePost(req, res, config, adapter, transports);
        } else if (req.method === "GET") {
          await handleGet(req, res, transports);
        } else if (req.method === "DELETE") {
          await handleDelete(req, res, transports);
        } else {
          sendHttpError(res, 405, "Method not allowed");
        }
        return;
      }

      sendHttpError(res, 404, "Not found");
    } catch (err) {
      if (!res.headersSent) {
        sendHttpError(res, err instanceof PayloadTooLargeError ? 413 : 400, err instanceof Error ? err.message : String(err));
      } else {
        res.destroy();
      }
    }
  });

  const sessionSweep = setInterval(() => {
    const cutoff = Date.now() - config.sessionTtlMs;
    for (const [sessionId, managed] of transports) {
      if (managed.lastSeen < cutoff) {
        void managed.transport.close();
        void managed.logger.close();
        transports.delete(sessionId);
      }
    }
    limiter.sweep();
  }, Math.min(config.sessionTtlMs, 60_000));
  sessionSweep.unref();

  httpServer.listen(config.port, config.host, () => {
    console.log(`CodeHands MCP server running on http://${config.host}:${config.port}/mcp`);
    console.log(`Health check: http://${config.host}:${config.port}/health`);
    console.log(`HTTP authentication: ${config.auth.enabled ? `enabled (token: ${getTokenPath()})` : "DISABLED"}`);
    console.log(`Capability URL authentication: ${
      config.capabilityPath.enabled
        ? `enabled (token: ${getCapabilityTokenPath()})`
        : "disabled"
    }`);
    console.log(`Workspaces: ${config.workspaces.length > 0 ? config.workspaces.join(", ") : "(none)"}`);
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    clearInterval(sessionSweep);
    for (const [sid, managed] of transports) {
      await managed.transport.close();
      await managed.logger.close();
      transports.delete(sid);
    }
    await adapter.stop();
    httpServer.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    clearInterval(sessionSweep);
    for (const [sid, managed] of transports) {
      await managed.transport.close();
      await managed.logger.close();
      transports.delete(sid);
    }
    await adapter.stop();
    httpServer.close();
    process.exit(0);
  });
}

interface ManagedTransport {
  transport: StreamableHTTPServerTransport;
  logger: AuditLogger;
  lastSeen: number;
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  config: CodehandsConfig,
  adapter: CodexAdapter,
  transports: Map<string, ManagedTransport>,
) {
  const body = await readBody(req, config.maxRequestBytes);
  const parsed = JSON.parse(body);

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const managed = transports.get(sessionId)!;
    managed.lastSeen = Date.now();
    await managed.transport.handleRequest(req, res, parsed);
    return;
  }

  if (!sessionId && isInitializeRequest(parsed)) {
    const generatedSessionId = randomUUID();
    const logger = createAuditLogger();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => generatedSessionId,
      onsessioninitialized: (sid) => {
        transports.set(sid, { transport, logger, lastSeen: Date.now() });
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) transports.delete(sid);
      void logger.close();
    };

    const { server } = createServer(config, adapter, logger, generatedSessionId);
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
  transports: Map<string, ManagedTransport>,
) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.writeHead(400);
    res.end("Invalid or missing session ID");
    return;
  }
  const managed = transports.get(sessionId)!;
  managed.lastSeen = Date.now();
  await managed.transport.handleRequest(req, res);
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Map<string, ManagedTransport>,
) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.writeHead(400);
    res.end("Invalid or missing session ID");
    return;
  }
  const managed = transports.get(sessionId)!;
  managed.lastSeen = Date.now();
  await managed.transport.handleRequest(req, res);
}

class PayloadTooLargeError extends Error {}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      reject(new PayloadTooLargeError(`Request body exceeds ${maxBytes} bytes`));
      req.resume();
      return;
    }

    let data = "";
    let received = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      received += chunk.length;
      if (received > maxBytes) {
        rejected = true;
        reject(new PayloadTooLargeError(`Request body exceeds ${maxBytes} bytes`));
        req.resume();
        return;
      }
      data += chunk.toString("utf-8");
    });
    req.on("end", () => {
      if (!rejected) resolve(data);
    });
    req.on("error", reject);
  });
}

async function runStdio() {
  const config = loadConfig();
  const adapter = new CodexAdapter({ codexBinary: config.codexBinary });
  await adapter.start();
  const preflightWorkspace = config.workspaces.find((workspace) => fs.existsSync(workspace));
  if (preflightWorkspace) {
    await verifySandbox(adapter, preflightWorkspace);
  }

  const logger = createAuditLogger();
  const { server } = createServer(config, adapter, logger, `stdio-${randomUUID()}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  transport.onclose = () => {
    void logger.close();
    void adapter.stop();
  };
}

async function runInit() {
  const configPath = initConfig();
  console.log(`Config created at: ${configPath}`);
  console.log(`Edit this file to add your workspaces.`);
  console.log(`HTTP bearer token created at: ${getTokenPath()}`);
  console.log(`Capability URL token created at: ${getCapabilityTokenPath()}`);
}

async function runLogs() {
  const follow = args.includes("--follow") || args.includes("-f");
  const logDir = path.join(path.dirname(getConfigPath()), "logs");
  if (!fs.existsSync(logDir)) {
    console.log("No CodeHands activity has been logged yet.");
    return;
  }

  const printLatest = () => {
    const files = fs.readdirSync(logDir).filter((name) => name.endsWith(".jsonl")).sort();
    const latest = files.at(-1);
    if (!latest) return;
    const logPath = path.join(logDir, latest);
    const lines = fs.readFileSync(logPath, "utf-8").trimEnd().split("\n").slice(-50);
    process.stdout.write(lines.filter(Boolean).join("\n") + (lines.length ? "\n" : ""));
    return logPath;
  };

  const logPath = printLatest();
  if (!follow || !logPath) return;
  let offset = fs.statSync(logPath).size;
  console.log(`Following ${logPath} (Ctrl+C to stop)`);
  fs.watchFile(logPath, { interval: 500 }, (current) => {
    if (current.size <= offset) return;
    const stream = fs.createReadStream(logPath, { start: offset, end: current.size - 1, encoding: "utf-8" });
    stream.pipe(process.stdout, { end: false });
    offset = current.size;
  });
}

async function runDoctor() {
  const config = loadConfig();
  const problems: string[] = [];
  for (const workspace of config.workspaces) {
    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
      problems.push(`Workspace does not exist or is not a directory: ${workspace}`);
    }
  }
  if (config.auth.enabled && !config.authToken) {
    problems.push(`HTTP authentication is enabled but no token exists at ${getTokenPath()} or ${config.auth.tokenEnv}`);
  }
  if (config.capabilityPath.enabled) {
    if (!config.capabilityToken) {
      problems.push(
        `Capability URL authentication is enabled but no token exists at ${getCapabilityTokenPath()} or ${config.capabilityPath.tokenEnv}`,
      );
    } else if (!isValidCapabilityToken(config.capabilityToken)) {
      problems.push("Capability URL token must be at least 43 URL-safe characters");
    }
  }

  const adapter = new CodexAdapter({ codexBinary: config.codexBinary });
  try {
    await adapter.start();
    const info = await adapter.getEnvironmentInfo();
    console.log(`exec-server connected (${info.shell.name})`);

    const workspace = config.workspaces.find((candidate) => fs.existsSync(candidate));
    if (workspace) {
      console.log(`sandbox enforced (${await verifySandbox(adapter, workspace)})`);
    } else {
      problems.push("No existing workspace is configured, so sandbox enforcement could not be tested");
    }
  } catch (err) {
    problems.push(`exec-server compatibility or sandbox check failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await adapter.stop();
  }

  if (problems.length) {
    console.error("CodeHands doctor found problems:");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("CodeHands doctor: all checks passed.");
}

function createAuditLogger(): AuditLogger {
  return new AuditLogger({ logDir: path.join(path.dirname(getConfigPath()), "logs") });
}

async function verifySandbox(adapter: CodexAdapter, workspace: string): Promise<string> {
  const workspaceUri = pathToFileURL(workspace).href;
  const sandbox = createWorkspaceSandbox(workspaceUri);
  const argv = process.platform === "win32"
    ? ["cmd.exe", "/d", "/c", "exit", "0"]
    : ["/usr/bin/true"];
  const result = await adapter.processStart({
    argv,
    cwd: workspaceUri,
    env: { PATH: process.env["PATH"] ?? "" },
    tty: false,
    pipeStdin: false,
    sandbox,
  });
  await adapter.processRead({ processId: result.processId, waitMs: 1_000 }).catch(() => undefined);
  return result.sandboxType!;
}

function assertCapabilityToken(config: CodehandsConfig): void {
  if (!config.capabilityPath.enabled) return;
  if (!config.capabilityToken) {
    throw new Error("Capability URL authentication is enabled but its token is missing");
  }
  if (!isValidCapabilityToken(config.capabilityToken)) {
    throw new Error("Capability URL token must be at least 43 URL-safe characters");
  }
}

function runCapabilityUrl() {
  const config = loadConfig();
  assertCapabilityToken(config);
  if (!config.capabilityPath.enabled) {
    throw new Error(`Capability URL authentication is disabled in ${getConfigPath()}`);
  }

  const input = args[1];
  if (!input) {
    throw new Error("Provide the Funnel hostname, for example: codehands capability-url machine.tail1234.ts.net");
  }
  const origin = new URL(input.includes("://") ? input : `https://${input}`);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Capability URL host must be an HTTPS origin or hostname without a path, query, or fragment");
  }
  if (!config.allowedHosts.some((host) => host.toLowerCase() === origin.hostname.toLowerCase())) {
    throw new Error(`Add ${JSON.stringify(origin.hostname)} to allowedHosts in ${getConfigPath()} first`);
  }
  console.log(`${origin.origin}/${config.capabilityToken}/mcp`);
}

function runRotateCapability() {
  if (process.env["CODEHANDS_CAPABILITY_TOKEN"]) {
    throw new Error("Unset CODEHANDS_CAPABILITY_TOKEN before rotating the token file");
  }
  const tokenPath = rotateCapabilityTokenFile();
  console.log(`Capability URL token rotated at: ${tokenPath}`);
  console.log("Restart CodeHands and update the URL in every connected client.");
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
    case "logs":
      await runLogs();
      break;
    case "doctor":
      await runDoctor();
      break;
    case "capability-url":
      runCapabilityUrl();
      break;
    case "rotate-capability":
      runRotateCapability();
      break;
    default:
      console.log("CodeHands - MCP server for AI-powered coding");
      console.log("");
      console.log("Usage:");
      console.log("  codehands start    Start the HTTP MCP server");
      console.log("  codehands stdio    Run in stdio mode (for Claude Desktop)");
      console.log("  codehands init     Create default config file");
      console.log("  codehands logs -f  Follow sanitized tool activity");
      console.log("  codehands doctor   Verify configuration, exec-server, and sandboxing");
      console.log("  codehands capability-url <host>  Print the secret HTTPS MCP URL");
      console.log("  codehands rotate-capability      Replace a disclosed capability token");
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
