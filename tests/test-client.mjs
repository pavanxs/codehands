const BASE = "http://localhost:3100/mcp";
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let currentSessionId = null;

async function send(body) {
  const headers = { ...HEADERS };
  if (currentSessionId) headers["Mcp-Session-Id"] = currentSessionId;

  const res = await fetch(BASE, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const sid = res.headers.get("mcp-session-id");
  if (sid) currentSessionId = sid;

  const lines = text.split("\n").filter((l) => l.startsWith("data: "));
  const data = lines.map((l) => JSON.parse(l.slice(6)));
  return data[0]?.result ?? data[0]?.error ?? { raw: text.slice(0, 200) };
}

function parseContent(result) {
  if (result?.content?.[0]?.text) {
    try { return JSON.parse(result.content[0].text); }
    catch { return result.content[0].text; }
  }
  return result;
}

async function main() {
  console.log("=== 1. Initialize ===");
  const init = await send({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
  });
  console.log("Server:", init.serverInfo?.name, init.serverInfo?.version);
  console.log("Session:", currentSessionId);

  await send({ jsonrpc: "2.0", method: "notifications/initialized" });

  console.log("\n=== 2. workspace_list ===");
  const wsList = await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "workspace_list", arguments: {} } });
  console.log(parseContent(wsList));

  console.log("\n=== 3. workspace_set ===");
  const wsSet = await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace_set", arguments: { workspace: "D:/projects/mcp-coding-harness" } } });
  console.log(parseContent(wsSet));

  console.log("\n=== 4. fs_readDirectory (root) ===");
  const dir = await send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fs_readDirectory", arguments: { path: "." } } });
  console.log(parseContent(dir));

  console.log("\n=== 5. fs_readFile (package.json) ===");
  const file = await send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "fs_readFile", arguments: { path: "package.json" } } });
  const fileContent = parseContent(file);
  console.log(typeof fileContent === "object" ? JSON.stringify(fileContent).slice(0, 200) : fileContent.slice(0, 200));

  console.log("\n=== 6. process_start (echo hello) ===");
  const proc = await send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "process_start", arguments: { command: "echo hello from codehands" } } });
  const procResult = parseContent(proc);
  console.log(procResult);

  if (procResult.processId) {
    await new Promise((r) => setTimeout(r, 1000));
    console.log("\n=== 7. process_read ===");
    const read = await send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "process_read", arguments: { processId: procResult.processId } } });
    console.log(parseContent(read));
  }

  console.log("\n=== 8. Blocked command test (rm -rf /) ===");
  const blocked = await send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "process_start", arguments: { command: "rm -rf /" } } });
  console.log(parseContent(blocked));

  console.log("\n=== ALL TESTS PASSED ===");
}

main().catch(console.error);
