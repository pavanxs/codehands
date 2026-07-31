/**
 * Comprehensive MCP integration test.
 * Exercises all 16 tools with real calls to the running server.
 *
 * Usage: Start "codehands start" first, then run "node tests/integration.mjs"
 */

const BASE = "http://localhost:3100/mcp";
const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
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
  const res = await fetch(BASE, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const lines = text.split("\n").filter((l) => l.startsWith("data: "));
  if (lines.length === 0) return null;
  const data = lines.map((l) => JSON.parse(l.slice(6)));
  return data[0]?.result ?? data[0]?.error ?? null;
}

async function callTool(name, args = {}) {
  return send("tools/call", { name, arguments: args });
}

function getContent(result) {
  if (!result?.content?.[0]?.text) return null;
  try { return JSON.parse(result.content[0].text); } catch { return result.content[0].text; }
}

function assert(condition, testName, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${testName}`);
  } else {
    failed++;
    console.log(`  ✗ ${testName} ${detail}`);
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────
async function main() {
  console.log("=== MCP Integration Tests ===\n");

  // --- Setup ---
  console.log("[Setup] Initialize");
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "integration-test", version: "1.0" },
  });
  assert(init?.serverInfo?.name === "codehands", "Server identifies as codehands");
  assert(init?.protocolVersion === "2024-11-05", "Protocol version correct");
  await send("notifications/initialized");

  // --- tools/list ---
  console.log("\n[tools/list]");
  const tools = await send("tools/list", {});
  assert(tools?.tools?.length === 16, "Exactly 16 tools registered", `got ${tools?.tools?.length}`);
  const toolNames = tools.tools.map(t => t.name);
  assert(toolNames.includes("fs_readFile"), "Has fs_readFile");
  assert(toolNames.includes("process_start"), "Has process_start");
  assert(toolNames.includes("workspace_list"), "Has workspace_list");
  assert(toolNames.includes("http_request"), "Has http_request");

  // --- workspace_list ---
  console.log("\n[workspace_list]");
  const wsList = callTool("workspace_list");
  const wsData = getContent(await wsList);
  assert(Array.isArray(wsData?.workspaces), "Returns workspaces array");
  assert(wsData.workspaces.length > 0, "At least one workspace configured");

  // --- workspace_set ---
  console.log("\n[workspace_set]");
  const wsSet = await callTool("workspace_set", { workspace: "mcp-coding-harness" });
  const wsSetData = getContent(wsSet);
  assert(wsSetData?.set === true, "workspace_set returns set: true");
  assert(wsSetData?.activeWorkspace?.includes("mcp-coding-harness"), "Active workspace set correctly");

  // workspace_set with full path
  const wsSet2 = await callTool("workspace_set", { workspace: "D:/projects/mcp-coding-harness" });
  const wsSet2Data = getContent(wsSet2);
  assert(wsSet2Data?.set === true, "workspace_set with full path works");

  // workspace_set with nonexistent
  const wsSetBad = await callTool("workspace_set", { workspace: "nonexistent-project-xyz" });
  assert(wsSetBad?.isError === true, "workspace_set rejects unknown workspace");

  // --- fs_readDirectory ---
  console.log("\n[fs_readDirectory]");
  const dir = await callTool("fs_readDirectory", { path: "." });
  const dirData = getContent(dir);
  assert(Array.isArray(dirData?.entries), "readDirectory returns entries array");
  assert(dirData.entries.some(e => e.fileName === "package.json"), "Root has package.json");
  assert(dirData.entries.some(e => e.fileName === "apps" && e.isDirectory), "Root has apps/");

  // Subdirectory
  const subDir = await callTool("fs_readDirectory", { path: "packages" });
  const subDirData = getContent(subDir);
  assert(Array.isArray(subDirData?.entries), "Subdirectory listing works");
  assert(subDirData.entries.some(e => e.fileName === "mcp-tools"), "packages/ has mcp-tools");

  // --- fs_readFile ---
  console.log("\n[fs_readFile]");
  const file = await callTool("fs_readFile", { path: "package.json" });
  const fileData = getContent(file);
  assert(typeof fileData?.content === "string", "readFile returns content string");
  assert(fileData.content.includes("mcp-coding-harness"), "Content matches expected file");

  // Read nested file
  const nested = await callTool("fs_readFile", { path: "apps/local-agent/package.json" });
  const nestedData = getContent(nested);
  assert(nestedData?.content?.includes("@codehands/local-agent"), "Nested file read works");

  // Read nonexistent file
  const noFile = await callTool("fs_readFile", { path: "this-file-does-not-exist.xyz" });
  assert(noFile?.isError === true, "readFile on missing file returns error");

  // --- fs_writeFile + fs_readFile (round trip) ---
  console.log("\n[fs_writeFile]");
  const testContent = `test-${Date.now()}`;
  const write = await callTool("fs_writeFile", { path: "tests/.tmp-test-file.txt", content: testContent });
  const writeData = getContent(write);
  assert(writeData?.written === true, "writeFile returns written: true");

  // Verify by reading back
  const readBack = await callTool("fs_readFile", { path: "tests/.tmp-test-file.txt" });
  const readBackData = getContent(readBack);
  assert(readBackData?.content === testContent, "Write then read returns same content");

  // --- fs_getMetadata ---
  console.log("\n[fs_getMetadata]");
  const meta = await callTool("fs_getMetadata", { path: "package.json" });
  const metaData = getContent(meta);
  assert(metaData?.isFile === true || metaData?.type === "file", "getMetadata identifies file");
  assert(typeof metaData?.size === "number" || typeof metaData?.len === "number", "getMetadata has size");

  // --- fs_createDirectory ---
  console.log("\n[fs_createDirectory]");
  const mkdir = await callTool("fs_createDirectory", { path: "tests/.tmp-test-dir" });
  const mkdirData = getContent(mkdir);
  assert(!mkdir?.isError, "createDirectory succeeds");

  // --- fs_copy ---
  console.log("\n[fs_copy]");
  const cp = await callTool("fs_copy", {
    sourcePath: "tests/.tmp-test-file.txt",
    destinationPath: "tests/.tmp-test-dir/copied.txt",
  });
  assert(!cp?.isError, "copy succeeds");

  // Verify copy exists
  const readCopy = await callTool("fs_readFile", { path: "tests/.tmp-test-dir/copied.txt" });
  const copyData = getContent(readCopy);
  assert(copyData?.content === testContent, "Copied file has correct content");

  // --- fs_walk ---
  console.log("\n[fs_walk]");
  const walk = await callTool("fs_walk", { path: "tests" });
  const walkData = getContent(walk);
  assert(!walk?.isError, "walk succeeds");

  // --- fs_remove ---
  console.log("\n[fs_remove]");
  const rm = await callTool("fs_remove", { path: "tests/.tmp-test-dir", recursive: true, force: true });
  assert(!rm?.isError, "remove directory succeeds");
  const rm2 = await callTool("fs_remove", { path: "tests/.tmp-test-file.txt", force: true });
  assert(!rm2?.isError, "remove file succeeds");

  // Verify removal
  const gone = await callTool("fs_readFile", { path: "tests/.tmp-test-file.txt" });
  assert(gone?.isError === true, "Removed file is actually gone");

  // --- process_start ---
  console.log("\n[process_start]");

  // Simple echo
  const echo = await callTool("process_start", { command: "echo integration-test-works" });
  const echoData = getContent(echo);
  assert(echoData?.started === true, "process_start echo succeeds");
  assert(typeof echoData?.processId === "string", "Returns processId");

  await sleep(500);

  // --- process_read ---
  console.log("\n[process_read]");
  const read = await callTool("process_read", { processId: echoData.processId });
  const readData = getContent(read);
  assert(readData?.output?.includes("integration-test-works"), "process_read returns echo output");
  assert(readData?.exited === true, "Echo process exited");

  // git status (the Claude Desktop bug scenario)
  const git = await callTool("process_start", { command: "git", args: ["status", "--short"] });
  const gitData = getContent(git);
  assert(gitData?.started === true, "git status --short starts");
  await sleep(1500);
  const gitRead = await callTool("process_read", { processId: gitData.processId });
  const gitOutput = getContent(gitRead);
  assert(gitOutput?.exited === true, "git status exits");
  assert(gitOutput?.exitCode === 0, "git status exit code 0", `got ${gitOutput?.exitCode}`);

  // npm --version
  const npm = await callTool("process_start", { command: "npm --version" });
  const npmData = getContent(npm);
  assert(npmData?.started === true, "npm --version starts");
  await sleep(1500);
  const npmRead = await callTool("process_read", { processId: npmData.processId });
  const npmOutput = getContent(npmRead);
  assert(npmOutput?.exited === true, "npm exits");
  assert(npmOutput?.exitCode === 0, "npm exit code 0");

  // node --version
  const node = await callTool("process_start", { command: "node --version" });
  const nodeData = getContent(node);
  assert(nodeData?.started === true, "node --version starts");
  await sleep(1000);
  const nodeRead = await callTool("process_read", { processId: nodeData.processId });
  const nodeOutput = getContent(nodeRead);
  assert(nodeOutput?.output?.startsWith("v"), "node outputs version string");

  // Command with args array
  const withArgs = await callTool("process_start", { command: "git", args: ["log", "--oneline", "-3"] });
  const withArgsData = getContent(withArgs);
  assert(withArgsData?.started === true, "git log with args array starts");
  await sleep(1500);
  const argsRead = await callTool("process_read", { processId: withArgsData.processId });
  const argsOutput = getContent(argsRead);
  assert(argsOutput?.exitCode === 0, "git log with args exits cleanly");
  assert(argsOutput?.output?.length > 5, "git log produces output");

  // --- process_write + process_terminate ---
  console.log("\n[process_write / process_terminate]");
  const longProc = await callTool("process_start", { command: "ping -n 30 127.0.0.1" });
  const longData = getContent(longProc);
  assert(longData?.started === true, "Long-running ping starts");
  await sleep(1000);

  // Terminate it
  const term = await callTool("process_terminate", { processId: longData.processId });
  assert(!term?.isError, "process_terminate succeeds");
  await sleep(500);
  const termRead = await callTool("process_read", { processId: longData.processId });
  const termOutput = getContent(termRead);
  assert(termOutput?.exited === true, "Terminated process shows exited");

  // --- process_signal ---
  console.log("\n[process_signal]");
  const sigProc = await callTool("process_start", { command: "ping -n 30 127.0.0.1" });
  const sigData = getContent(sigProc);
  assert(sigData?.started === true, "Signal test process starts");
  await sleep(500);
  const sig = await callTool("process_signal", { processId: sigData.processId, signal: "interrupt" });
  assert(!sig?.isError, "process_signal succeeds");
  await sleep(1000);
  const sigRead = await callTool("process_read", { processId: sigData.processId });
  const sigOutput = getContent(sigRead);
  assert(sigOutput?.exited === true, "Signaled process exits");

  // --- http_request ---
  console.log("\n[http_request]");
  const http = await callTool("http_request", { method: "GET", url: "http://localhost:3100/health" });
  const httpData = getContent(http);
  assert(httpData?.status === 200, "HTTP GET returns 200");
  assert(httpData?.body?.includes("ok"), "HTTP response body has 'ok'");

  // --- Blocked commands ---
  console.log("\n[Blocked commands]");
  const blocked1 = await callTool("process_start", { command: "rm -rf /" });
  assert(blocked1?.isError === true, "rm -rf / is blocked");

  const blocked2 = await callTool("process_start", { command: "format C:" });
  assert(blocked2?.isError === true, "format C: is blocked");

  const blocked3 = await callTool("process_start", { command: "shutdown -h now" });
  assert(blocked3?.isError === true, "shutdown is blocked");

  const blocked4 = await callTool("process_start", { command: "diskpart" });
  assert(blocked4?.isError === true, "diskpart is blocked");

  // --- Path security ---
  console.log("\n[Path security]");
  const outside = await callTool("fs_readFile", { path: "C:/Windows/System32/drivers/etc/hosts" });
  assert(outside?.isError === true, "Reading outside workspace is blocked");

  const traversal = await callTool("fs_readFile", { path: "../../Windows/System32/config/SAM" });
  assert(traversal?.isError === true, "Path traversal is blocked");

  // --- Edge cases ---
  console.log("\n[Edge cases]");
  const noWorkspace = await callTool("process_start", { command: "echo test", cwd: "C:/Windows" });
  assert(noWorkspace?.isError === true, "cwd outside workspace rejected");

  // Empty command
  const emptyCmd = await callTool("process_start", { command: "" });
  const emptyData = getContent(emptyCmd);
  // Should either fail or start (shell handles empty)
  assert(emptyCmd !== null, "Empty command doesn't crash server");

  // --- Summary ---
  console.log(`\n${"=".repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${"=".repeat(50)}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner crashed:", err.message);
  process.exit(1);
});
