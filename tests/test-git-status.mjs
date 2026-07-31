const BASE = "http://localhost:3100/mcp";
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let sessionId = null;

async function send(body) {
  const headers = { ...HEADERS };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(BASE, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const lines = text.split("\n").filter((l) => l.startsWith("data: "));
  const data = lines.map((l) => JSON.parse(l.slice(6)));
  return data[0]?.result ?? data[0]?.error ?? { raw: text.slice(0, 300) };
}

async function main() {
  console.log("1. Initialize");
  await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } });
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });

  console.log("2. workspace_set");
  const ws = await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "workspace_set", arguments: { workspace: "D:/projects/mcp-coding-harness" } } });
  console.log("  Result:", JSON.parse(ws.content[0].text));

  console.log("3. process_start (git status --short) — same way Claude calls it");
  const proc = await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "process_start", arguments: { command: "git", args: ["status", "--short"] } } });
  console.log("  Result:", JSON.parse(proc.content[0].text));

  if (proc.isError) {
    console.log("  ERROR! process_start failed:", proc.content[0].text);
    return;
  }

  const { processId } = JSON.parse(proc.content[0].text);
  await new Promise((r) => setTimeout(r, 1500));

  console.log("4. process_read");
  const read = await send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "process_read", arguments: { processId } } });
  console.log("  Result:", JSON.parse(read.content[0].text));
}

main().catch(console.error);
