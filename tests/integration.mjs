import * as os from "node:os";
import * as path from "node:path";

/**
 * Comprehensive cross-platform MCP integration test.
 *
 * Usage: start CodeHands first, then run:
 *   node tests/integration.mjs
 */

const BASE = process.env.CODEHANDS_MCP_URL ?? "http://localhost:3100/mcp";
const HEALTH_URL = new URL("/health", BASE).toString();
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let sessionId = null;
let nextId = 1;
let passed = 0;
let failed = 0;

async function send(method, params) {
  const id = nextId++;
  const body = params !== undefined
    ? { jsonrpc: "2.0", id, method, params }
    : { jsonrpc: "2.0", method };
  const headers = { ...HEADERS };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const response = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const returnedSessionId = response.headers.get("mcp-session-id");
  if (returnedSessionId) sessionId = returnedSessionId;

  const lines = text.split("\n").filter((line) => line.startsWith("data: "));
  if (lines.length === 0) return null;
  const data = lines.map((line) => JSON.parse(line.slice(6)));
  return data[0]?.result ?? data[0]?.error ?? null;
}

const MULTI_REQUEST_TOOLS = new Set([
  "fs_readFile", "fs_writeFile", "fs_createDirectory", "fs_readDirectory",
  "fs_walk", "fs_remove", "fs_copy", "fs_getMetadata", "process_run",
  "process_start", "process_read", "process_write", "process_signal",
  "process_terminate", "http_request",
]);

async function callTool(name, args = {}) {
  const actualArgs = MULTI_REQUEST_TOOLS.has(name) && !Array.isArray(args.requests)
    ? { requests: [args] }
    : args;
  const result = await send("tools/call", { name, arguments: actualArgs });
  if (!MULTI_REQUEST_TOOLS.has(name) || !result?.content?.[0]?.text) return result;
  try {
    const parsed = JSON.parse(result.content[0].text);
    const item = parsed?.results?.[0];
    if (!item) return result;
    return {
      ...result,
      isError: item.success === false,
      content: [{ type: "text", text: JSON.stringify(item) }],
    };
  } catch {
    return result;
  }
}

function getContent(result) {
  if (!result?.content?.[0]?.text) return null;
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return result.content[0].text;
  }
}

function assert(condition, testName, detail = "") {
  if (condition) {
    passed++;
    console.log(`  âœ“ ${testName}`);
  } else {
    failed++;
    console.log(`  âœ— ${testName}${detail ? ` â€” ${detail}` : ""}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readUntilExit(processId, attempts = 20) {
  let afterSeq;
  let output = "";
  let latest = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    latest = getContent(await callTool("process_read", {
      processId,
      afterSeq,
      waitMs: 500,
    }));
    if (!latest || typeof latest !== "object") return latest;
    const chunkOutput = Array.isArray(latest.chunks) ? latest.chunks.map((chunk) => chunk.text).join("") : "";
    output += chunkOutput;
    if (typeof latest.nextAfterSeq === "number") afterSeq = latest.nextAfterSeq;
    if (latest.closed) return { ...latest, output };
  }

  return latest ? { ...latest, output } : latest;
}

async function startPortableLongProcess() {
  return callTool("process_start", {
    command: "node",
    args: ["-e", "setInterval(() => {}, 1000)"],
    shell: false,
  });
}

async function main() {
  console.log(`=== MCP Integration Tests (${process.platform}) ===\n`);

  console.log("[Setup] Initialize");
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "integration-test", version: "1.0" },
  });
  assert(init?.serverInfo?.name === "codehands", "Server identifies as codehands");
  assert(init?.protocolVersion === "2024-11-05", "Protocol version correct");
  await send("notifications/initialized");

  console.log("\n[tools/list]");
  const tools = await send("tools/list", {});
  const toolNames = tools?.tools?.map((tool) => tool.name) ?? [];
  assert(toolNames.length >= 20, "Core tools registered", `got ${toolNames.length}`);
  assert(toolNames.includes("fs_readFile"), "Has fs_readFile");
  assert(toolNames.includes("process_start"), "Has process_start");
  assert(toolNames.includes("process_run"), "Has process_run");
  assert(toolNames.includes("workspace_list"), "Has workspace_list");
  assert(toolNames.includes("http_request"), "Has http_request");
  assert(toolNames.includes("process_signal"), "Has process_signal");

  console.log("\n[workspace]");
  const workspaceData = getContent(await callTool("workspace_list"));
  assert(Array.isArray(workspaceData?.workspaces), "Returns workspaces array");
  assert(workspaceData?.workspaces?.length > 0, "At least one workspace configured");

  const workspace = workspaceData.workspaces[0];
  const workspaceName = path.basename(workspace);
  const setByName = getContent(await callTool("workspace_set", { workspace: workspaceName }));
  assert(setByName?.set === true, "workspace_set by name works");
  const setByPath = getContent(await callTool("workspace_set", { workspace }));
  assert(setByPath?.set === true, "workspace_set by full path works");
  const badWorkspace = await callTool("workspace_set", { workspace: "nonexistent-project-xyz" });
  assert(badWorkspace?.isError === true, "workspace_set rejects unknown workspace");

  console.log("\n[file system]");
  const directory = getContent(await callTool("fs_readDirectory", { path: "." }));
  assert(Array.isArray(directory?.entries), "readDirectory returns entries");
  assert(directory.entries.some((entry) => entry.fileName === "package.json"), "Root has package.json");

  const packageFile = getContent(await callTool("fs_readFile", { path: "package.json" }));
  assert(typeof packageFile?.content === "string", "readFile returns content");
  assert(packageFile.content.includes("mcp-coding-harness"), "Read content is correct");

  const missingFile = await callTool("fs_readFile", { path: "this-file-does-not-exist.xyz" });
  assert(missingFile?.isError === true, "Missing file returns an error");

  const temporaryFile = "tests/.tmp-integration-file.txt";
  const temporaryDirectory = "tests/.tmp-integration-directory";
  const testContent = `test-${Date.now()}`;

  const write = getContent(await callTool("fs_writeFile", {
    path: temporaryFile,
    content: testContent,
  }));
  assert(write?.written === true, "writeFile succeeds");
  const readBack = getContent(await callTool("fs_readFile", { path: temporaryFile }));
  assert(readBack?.content === testContent, "Write/read round trip matches");

  const metadata = getContent(await callTool("fs_getMetadata", { path: temporaryFile }));
  assert(metadata?.isFile === true, "getMetadata identifies a file");
  assert(typeof metadata?.size === "number", "getMetadata returns file size");

  const makeDirectory = await callTool("fs_createDirectory", { path: temporaryDirectory });
  assert(!makeDirectory?.isError, "createDirectory succeeds");
  const copy = await callTool("fs_copy", {
    sourcePath: temporaryFile,
    destinationPath: `${temporaryDirectory}/copied.txt`,
  });
  assert(!copy?.isError, "copy succeeds");
  const copied = getContent(await callTool("fs_readFile", {
    path: `${temporaryDirectory}/copied.txt`,
  }));
  assert(copied?.content === testContent, "Copied content matches");

  const walk = await callTool("fs_walk", { path: "tests", maxDepth: 2 });
  assert(!walk?.isError, "fs_walk succeeds");

  await callTool("fs_remove", { path: temporaryDirectory, recursive: true, force: true });
  await callTool("fs_remove", { path: temporaryFile, force: true });
  const removed = await callTool("fs_readFile", { path: temporaryFile });
  assert(removed?.isError === true, "Temporary files are removed");

  console.log("\n[process execution]");
  const shellProcess = getContent(await callTool("process_start", {
    command: "echo integration-test-works",
    shell: true,
  }));
  const shellResult = await readUntilExit(shellProcess.processId);
  assert(shellResult?.output?.includes("integration-test-works"), "Platform shell command works");
  assert(shellResult?.exitCode === 0, "Platform shell command exits successfully");

  const gitProcess = getContent(await callTool("process_start", {
    command: "git",
    args: ["status", "--short"],
    shell: false,
  }));
  const gitResult = await readUntilExit(gitProcess.processId);
  assert(gitResult?.exitCode === 0, "git with args[] exits successfully");

  const npmProcess = getContent(await callTool("process_start", {
    command: "npm",
    args: ["--version"],
    shell: false,
  }));
  const npmResult = await readUntilExit(npmProcess.processId);
  assert(npmResult?.exitCode === 0, "npm with args[] works on this platform");
  assert(/^\d+\.\d+/.test(npmResult?.output?.trim() ?? ""), "npm returns a version");

  const exactArgs = getContent(await callTool("process_start", {
    command: "node",
    args: ["-p", "process.argv.slice(1).length", "A B"],
    shell: false,
  }));
  const exactArgsResult = await readUntilExit(exactArgs.processId);
  assert(exactArgsResult?.output?.trim() === "1", "Process argument boundaries are preserved");

  const stdinProcess = getContent(await callTool("process_start", {
    command: "node",
    args: [
      "-e",
      "process.stdin.once('data', data => { console.log(data.toString().trim()); process.exit(0); })",
    ],
    shell: false,
  }));
  let writeStatus = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    writeStatus = getContent(await callTool("process_write", {
      processId: stdinProcess.processId,
      input: "stdin-works\n",
    }));
    if (writeStatus?.status === "accepted") break;
    await sleep(100);
  }
  const stdinResult = await readUntilExit(stdinProcess.processId);
  assert(writeStatus?.status === "accepted", "process_write accepts stdin");
  assert(stdinResult?.output?.includes("stdin-works"), "Non-TTY stdin reaches the process");

  const longProcess = getContent(await startPortableLongProcess());
  await sleep(250);
  const terminate = await callTool("process_terminate", { processId: longProcess.processId });
  assert(!terminate?.isError, "process_terminate succeeds");
  const terminatedResult = await readUntilExit(longProcess.processId);
  assert(
    terminatedResult?.exited === true || terminatedResult?.closed === true,
    "Terminated process is reported as stopped",
  );

  {
    const signalProcess = getContent(await startPortableLongProcess());
    await sleep(250);
    const signalResult = await callTool("process_signal", {
      processId: signalProcess.processId,
      signal: "interrupt",
    });
    if (signalResult?.isError) {
      const message = signalResult.content?.[0]?.text ?? "";
      assert(
        process.platform === "win32" && /not supported/i.test(message),
        "Unsupported interrupt is reported by the Windows backend",
        message,
      );
      await callTool("process_terminate", { processId: signalProcess.processId });
    } else {
      assert(true, "process_signal succeeds on this backend");
    }
    const interrupted = await readUntilExit(signalProcess.processId);
    assert(
      interrupted?.exited === true || interrupted?.closed === true,
      "Signaled or terminated process stops",
    );
  }

  console.log("\n[batch safety]");
  const batchResult = getContent(await callTool("batch", {
    calls: [{ tool: "workspace_set", args: { workspace } }],
  }));
  assert(batchResult?.results?.[0]?.success === false, "workspace_set is rejected inside batch");

  console.log("\n[HTTP]");
  const health = getContent(await callTool("http_request", {
    method: "GET",
    url: HEALTH_URL,
  }));
  assert(health?.status === 200, "HTTP GET returns 200");
  assert(health?.body?.includes("ok"), "HTTP response contains health status");

  console.log("\n[command policy]");
  const shutdown = await callTool("process_start", { command: "shutdown -h now", shell: true });
  assert(shutdown?.isError === true, "shutdown command is blocked");
  if (process.platform === "win32") {
    const format = await callTool("process_start", { command: "format C:", shell: true });
    const diskpart = await callTool("process_start", { command: "diskpart", shell: true });
    assert(format?.isError === true, "Windows format command is blocked");
    assert(diskpart?.isError === true, "Windows diskpart command is blocked");
  } else {
    const removeRoot = await callTool("process_start", { command: "rm -rf /", shell: true });
    assert(removeRoot?.isError === true, "POSIX root removal is blocked");
  }

  console.log("\n[path security]");
  const outsideAbsolute = path.join(
    os.tmpdir(),
    `codehands-outside-${process.pid}-${Date.now()}`,
    "secret.txt",
  );
  const outsideRead = await callTool("fs_readFile", { path: outsideAbsolute });
  assert(outsideRead?.isError === true, "Absolute path outside workspace is blocked");

  const traversalPath = path.join("..", "..", `codehands-outside-${Date.now()}`, "secret.txt");
  const traversalRead = await callTool("fs_readFile", { path: traversalPath });
  assert(traversalRead?.isError === true, "Relative path traversal is blocked");

  const outsideCwd = await callTool("process_start", {
    command: "node",
    args: ["--version"],
    shell: false,
    cwd: os.tmpdir(),
  });
  assert(outsideCwd?.isError === true, "Process cwd outside workspace is blocked");

  const emptyCommand = await callTool("process_start", { command: "", shell: false });
  assert(emptyCommand?.isError === true, "Empty command is rejected");

  console.log(`\n${"=".repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("=".repeat(50));

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Test runner crashed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
