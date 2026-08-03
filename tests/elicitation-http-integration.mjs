import assert from "node:assert/strict";
import { Client } from "../apps/local-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../apps/local-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import { ElicitRequestSchema } from "../apps/local-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";

const url = new URL(process.env.CODEHANDS_MCP_URL ?? "http://localhost:3101/mcp");
const client = new Client(
  { name: "elicitation-http-integration", version: "1.0.0" },
  { capabilities: { elicitation: { form: {} } } },
);
let captured;
client.setRequestHandler(ElicitRequestSchema, async (request) => {
  captured = request.params;
  return { action: "accept", content: { value: "SQLite" } };
});

const transport = new StreamableHTTPClientTransport(url);
await client.connect(transport);
try {
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 24);
  assert.equal(listed.tools.some((tool) => tool.name === "request_user_input"), true);

  const result = await client.callTool({
    name: "request_user_input",
    arguments: {
      message: "Which database should I configure?",
      label: "Database",
      placeholder: "Enter a database",
      minLength: 1,
      maxLength: 100,
    },
  });
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  assert.deepEqual(JSON.parse(text), { action: "accept", value: "SQLite" });
  assert.deepEqual(result.structuredContent, { action: "accept", value: "SQLite" });
  assert.deepEqual(captured, {
    mode: "form",
    message: "Which database should I configure?",
    requestedSchema: {
      type: "object",
      properties: {
        value: {
          type: "string",
          title: "Database",
          description: "Enter a database",
          minLength: 1,
          maxLength: 100,
        },
      },
      required: ["value"],
    },
  });
  console.log("elicitation HTTP integration checks passed: 6");
} finally {
  await client.close();
}
