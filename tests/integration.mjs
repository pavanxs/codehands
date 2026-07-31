/**
 * Manual authenticated end-to-end smoke test.
 *
 * Start CodeHands with a disposable configured workspace, then run:
 *   node tests/integration.mjs
 *
 * Optional:
 *   CODEHANDS_URL=http://127.0.0.1:3100/mcp
 *   CODEHANDS_TOKEN=...
 *   CODEHANDS_TEST_WORKSPACE=/exact/configured/path
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const endpoint = process.env.CODEHANDS_URL ?? "http://127.0.0.1:3100/mcp";
const token = process.env.CODEHANDS_TOKEN
  ?? readFileSync(join(homedir(), ".codehands", "http-token"), "utf-8").trim();

class McpClient {
  sessionId;
  nextId = 1;

  async send(method, params) {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    const message = events.at(0);
    if (message?.error) throw new Error(JSON.stringify(message.error));
    return message?.result;
  }

  async initialize() {
    return this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codehands-integration", version: "1.0" },
    });
  }

  async tool(name, args = {}) {
    return this.send("tools/call", { name, arguments: args });
  }
}

function data(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`✓ ${message}`);
}

async function waitForExit(client, processId) {
  let sequence = 0;
  let output = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await client.tool("process_read", {
      processId,
      afterSeq: sequence,
      waitMs: 250,
    });
    const result = data(response);
    output += result.output;
    sequence = result.nextSeq;
    if (result.exited) return { ...result, output };
  }
  throw new Error("Process did not exit before integration timeout");
}

const first = new McpClient();
const second = new McpClient();
const temporaryDirectory = `.codehands-integration-${randomUUID()}`;

try {
  const initialized = await first.initialize();
  assert(initialized.serverInfo.name === "codehands", "server initializes");

  const tools = await first.send("tools/list", {});
  assert(tools.tools.length === 22, "all 22 tools are registered");

  const workspaceList = data(await first.tool("workspace_list"));
  const workspace = process.env.CODEHANDS_TEST_WORKSPACE ?? workspaceList.workspaces[0];
  assert(Boolean(workspace), "a disposable test workspace is configured");
  assert(data(await first.tool("workspace_set", { workspace })).set, "workspace is selected");

  await first.tool("fs_createDirectory", { path: temporaryDirectory });
  const testFile = `${temporaryDirectory}/sample.txt`;
  await first.tool("fs_writeFile", { path: testFile, content: "alpha\nbeta\n" });
  assert(data(await first.tool("fs_readFile", { path: testFile, startLine: 2, endLine: 2 })).content === "beta", "line-range read works");

  await first.tool("fs_replaceText", { path: testFile, oldText: "beta", newText: "bravo" });
  await first.tool("fs_applyPatch", {
    path: testFile,
    patch: "@@ -1,2 +1,2 @@\n-alpha\n+ALPHA\n bravo",
  });
  const changed = data(await first.tool("fs_readFile", { path: testFile }));
  assert(changed.content === "ALPHA\nbravo\n", "replace and patch are conflict-safe");

  const search = data(await first.tool("fs_searchText", {
    query: "bravo",
    path: temporaryDirectory,
    fixedStrings: true,
  }));
  assert(Array.isArray(search?.matches), `workspace search succeeds: ${JSON.stringify(search)}`);
  assert(search.matches.length === 1, "workspace search returns the edit");

  const gitStatus = data(await first.tool("git_status"));
  assert(typeof gitStatus?.status === "string", `git status tool succeeds: ${JSON.stringify(gitStatus)}`);
  assert(!gitStatus.status.includes("fatal:"), "git status tool runs");
  const gitDiff = data(await first.tool("git_diff", { path: temporaryDirectory }));
  assert(typeof gitDiff?.diff === "string", `git diff tool runs: ${JSON.stringify(gitDiff)}`);

  const started = data(await first.tool("process_start", {
    command: "node",
    args: ["-e", "process.stdout.write('sandbox-ok')"],
  }));
  assert(started.sandboxType && started.sandboxType !== "none", "process reports a platform sandbox");

  await second.initialize();
  await second.tool("workspace_set", { workspace });
  const stolen = await second.tool("process_read", { processId: started.processId });
  assert(stolen.isError === true, "another MCP session cannot access the process");

  const exited = await waitForExit(first, started.processId);
  assert(exited.output === "sandbox-ok" && exited.exitCode === 0, "sandboxed argv process completes");

  const http = await first.tool("http_request", { method: "GET", url: "https://example.com" });
  assert(http.isError === true, "outbound HTTP is disabled by default");

  const activity = data(await first.tool("activity_recent", { limit: 10 }));
  assert(activity.activity.length > 0, "sanitized session activity is visible");
} finally {
  try {
    await first.tool("fs_remove", {
      path: temporaryDirectory,
      recursive: true,
      force: true,
    });
  } catch {
    // The test may have failed before workspace selection.
  }
}

console.log("CodeHands integration smoke test passed.");
