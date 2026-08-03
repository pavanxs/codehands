import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CODEHANDS_MCP_URL ?? "http://localhost:3101/mcp";
const workspace = path.resolve(".");
const temporaryPatchFile = path.join(workspace, "tests", ".tmp-new-tools-patch.txt");
const temporaryImageFile = path.join(workspace, "tests", ".tmp-new-tools-image.png");
let sessionId;
let nextId = 1;

async function send(method, params) {
  const id = nextId++;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };
  const response = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify(params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", id, method, params }),
  });
  sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  const text = await response.text();
  const events = text.split("\n").filter((line) => line.startsWith("data: "));
  if (events.length === 0) return null;
  const message = JSON.parse(events[0].slice(6));
  if (message.error) throw new Error(JSON.stringify(message.error));
  return message.result;
}

async function callTool(name, arguments_) {
  return send("tools/call", { name, arguments: arguments_ ?? {} });
}

function textData(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string", `Missing text result for ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

try {
  const initialized = await send("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "new-tools-integration", version: "1.0.0" },
  });
  assert.equal(initialized.serverInfo.name, "codehands");
  await send("notifications/initialized");

  const listed = await send("tools/list", {});
  const names = listed.tools.map((tool) => tool.name);
  assert.equal(names.length, 23);
  assert.equal(names.includes("request_user_input"), false);
  for (const name of ["repo_query", "fs_applyPatch", "view_image"]) {
    assert.equal(names.includes(name), true, `Missing ${name}`);
  }

  const overview = textData(await callTool("repo_query", { mode: "overview" }));
  assert.equal(overview.success, true);
  assert.equal(overview.mode, "overview");
  assert.equal(typeof overview.fileCount, "number");
  assert.equal(Array.isArray(overview.topLevel), true);

  const search = textData(await callTool("repo_query", {
    mode: "search",
    query: "request_user_input",
    searchIn: "content",
    patternType: "literal",
    maxResults: 10,
  }));
  assert.equal(search.success, true);
  assert.equal(search.includesUntracked, true);
  assert.equal(search.matches.length > 0, true);

  const patch = "*** Begin Patch\n*** Add File: tests/.tmp-new-tools-patch.txt\n+patched through MCP\n*** End Patch";
  const dryRun = textData(await callTool("fs_applyPatch", { patch, dryRun: true }));
  assert.equal(dryRun.success, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(fs.existsSync(temporaryPatchFile), false);

  const applied = textData(await callTool("fs_applyPatch", { patch }));
  assert.equal(applied.success, true);
  assert.equal(applied.partialApplied, false);
  assert.equal(fs.readFileSync(temporaryPatchFile, "utf8"), "patched through MCP\n");

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(temporaryImageFile, png);
  const imageResult = await callTool("view_image", { path: "tests/.tmp-new-tools-image.png" });
  const imageMetadata = textData(imageResult);
  assert.deepEqual(imageMetadata, {
    path: temporaryImageFile,
    success: true,
    mimeType: "image/png",
    bytes: png.length,
    width: 1,
    height: 1,
  });
  const image = imageResult.content.find((item) => item.type === "image");
  assert.equal(image?.mimeType, "image/png");
  assert.equal(image?.data, png.toString("base64"));

  console.log("new-tools HTTP integration checks passed: 15");
} finally {
  fs.rmSync(temporaryPatchFile, { force: true });
  fs.rmSync(temporaryImageFile, { force: true });
}
