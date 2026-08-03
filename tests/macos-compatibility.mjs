import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "../apps/local-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../apps/local-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

assert.equal(process.platform, "darwin", "This compatibility suite must run on macOS.");

const root = path.resolve(".");
const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "codehands-macos-home-"));
const patchFixture = path.join(root, "tests", ".tmp-macos-overwrite.txt");
let server;
let logViewer;
let client;
let serverOutput = "";
let logOutput = "";
let serverError;
let logViewerError;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code=${code}, signal=${signal}`));
    });
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      assert(address && typeof address === "object");
      const port = address.port;
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForHealth(port) {
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (!response.ok) return false;
    const body = await response.json();
    return body.status === "ok";
  }, `health endpoint on port ${port}`);
}

function processRows() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,comm=,args="], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3], args: match[4] }];
  });
}

function descendants(rootPid) {
  const rows = processRows();
  const ids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => ids.has(row.pid));
}

function nativeCodexChildren(rootPid) {
  return descendants(rootPid).filter((row) => path.basename(row.comm).toLowerCase().includes("codex") && row.args.includes("exec-server"));
}

async function connectClient(port, name) {
  const next = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await next.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return next;
}

function parseText(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string", `Missing text result: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

const port = await freePort();
const codehandsDirectory = path.join(temporaryHome, ".codehands");
fs.mkdirSync(codehandsDirectory, { recursive: true });
fs.writeFileSync(path.join(codehandsDirectory, "config.json"), JSON.stringify({
  workspaces: [root],
  port,
  blockedCommands: [],
}, null, 2) + "\n");

const isolatedEnvironment = {
  HOME: temporaryHome,
  USERPROFILE: temporaryHome,
  CODEHANDS_MCP_URL: `http://127.0.0.1:${port}/mcp`,
};

try {
  server = spawn("node", ["apps/local-agent/dist/cli.js", "start", "--batch"], {
    cwd: root,
    env: { ...process.env, ...isolatedEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    serverOutput += text;
    process.stdout.write(text);
  });
  server.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    serverOutput += text;
    process.stderr.write(text);
  });
  server.once("error", (error) => { serverError = error; });

  await waitFor(async () => {
    if (serverError) throw serverError;
    if (server.exitCode !== null) throw new Error(`Server exited before startup with code ${server.exitCode}.`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      return response.ok && (await response.json()).status === "ok";
    } catch {
      return false;
    }
  }, `server startup on port ${port}`);

  await run("node", ["tests/integration.mjs"], isolatedEnvironment);
  await run("node", ["tests/new-tools-integration.mjs"], isolatedEnvironment);
  await run("node", ["tests/elicitation-http-integration.mjs"], isolatedEnvironment);

  client = await connectClient(port, "macos-compatibility");

  fs.writeFileSync(patchFixture, "original\n");
  const overwrite = await client.callTool({
    name: "fs_applyPatch",
    arguments: {
      patch: "*** Begin Patch\n*** Add File: tests/.tmp-macos-overwrite.txt\n+replacement\n*** End Patch",
    },
  });
  const overwriteData = parseText(overwrite);
  assert.equal(overwrite.isError, true);
  assert.equal(overwriteData.success, false);
  assert.equal(overwriteData.error.code, "PATCH_OVERWRITE_REJECTED");
  assert.equal(fs.readFileSync(patchFixture, "utf8"), "original\n");
  fs.rmSync(patchFixture, { force: true });

  const codexBefore = await waitFor(() => {
    const children = nativeCodexChildren(server.pid);
    return children.length === 1 ? children : false;
  }, "one native Codex exec-server child");
  process.kill(codexBefore[0].pid, "SIGKILL");

  await waitFor(() => serverOutput.includes("exec-server crashed, restarting (1/3)..."), "single restart notification");
  await waitForHealth(port);
  await waitFor(async () => {
    try {
      const result = await client.callTool({
        name: "fs_readFile",
        arguments: { requests: [{ path: "package.json", fromLine: 1, toLine: 3 }] },
      });
      const data = parseText(result);
      return data.results[0]?.success === true && data.results[0].content.includes("mcp-coding-harness");
    } catch {
      return false;
    }
  }, "post-crash MCP read");
  await delay(1_500);
  assert.equal((serverOutput.match(/exec-server crashed, restarting/g) ?? []).length, 1);
  assert.equal(nativeCodexChildren(server.pid).length, 1);

  logViewer = spawn("node", ["apps/local-agent/dist/cli.js", "logs"], {
    cwd: root,
    env: { ...process.env, ...isolatedEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  logViewer.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    logOutput += text;
    process.stdout.write(text);
  });
  logViewer.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    logOutput += text;
    process.stderr.write(text);
  });
  logViewer.once("error", (error) => { logViewerError = error; });
  await waitFor(() => {
    if (logViewerError) throw logViewerError;
    if (logViewer.exitCode !== null) throw new Error(`Log viewer exited with code ${logViewer.exitCode}.`);
    return logOutput.includes("idle=before call");
  }, "live-log header");

  await client.callTool({
    name: "batch",
    arguments: {
      calls: [
        {
          tool: "process_run",
          args: {
            requests: [{
              command: "node",
              args: ["-e", "setTimeout(() => {}, 2000)"],
              shell: false,
              timeoutMs: 100,
            }],
          },
        },
        {
          tool: "fs_readFile",
          args: { requests: [{ path: "package.json", fromLine: 1, toLine: 2 }] },
        },
      ],
    },
  });
  await waitFor(() => logOutput.includes("PARTIAL") && logOutput.includes("TIMEOUT") && logOutput.includes("idle "), "nested live-log outcomes");

  console.log("macOS comprehensive compatibility checks passed.");
} finally {
  fs.rmSync(patchFixture, { force: true });
  if (client) await client.close().catch(() => undefined);
  await stopChild(logViewer);
  await stopChild(server);
  fs.rmSync(temporaryHome, { recursive: true, force: true });
}
