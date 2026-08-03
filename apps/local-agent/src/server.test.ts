import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CodexAdapter } from "@codehands/codex-adapter";
import { createServer } from "./server.js";

interface ElicitationResponse {
  action: "accept" | "decline" | "cancel";
  value?: string;
}

async function createLinkedClient(
  workspaces: string[],
  sessionId: string,
  elicitationResponse?: ElicitationResponse,
): Promise<{
  client: Client;
  close: () => Promise<void>;
  lastElicitation: () => Record<string, unknown> | undefined;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server } = createServer(
    { workspaces, port: 3100, blockedCommands: [] },
    {} as CodexAdapter,
    undefined,
    sessionId,
    { batch: true },
  );
  const client = new Client(
    { name: `${sessionId}-client`, version: "1.0.0" },
    { capabilities: elicitationResponse ? { elicitation: { form: {} } } : {} },
  );
  let captured: Record<string, unknown> | undefined;
  if (elicitationResponse) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      captured = request.params as unknown as Record<string, unknown>;
      return elicitationResponse.action === "accept"
        ? { action: "accept", content: { value: elicitationResponse.value ?? "" } }
        : { action: elicitationResponse.action };
    });
  }
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    lastElicitation: () => captured,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textData(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text")?.text ?? "null";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("CodeHands MCP server", () => {
  it("forwards outputSchema and structuredContent over MCP", async () => {
    const linked = await createLinkedClient([process.cwd()], "server-test");
    try {
      const listed = await linked.client.listTools();
      const workspaceList = listed.tools.find((tool) => tool.name === "workspace_list");
      const processRun = listed.tools.find((tool) => tool.name === "process_run");

      expect(listed.tools).toHaveLength(23);
      expect(listed.tools.some((tool) => tool.name === "request_user_input")).toBe(false);
      expect(workspaceList?.outputSchema).toMatchObject({ type: "object" });
      expect(processRun?.inputSchema.required).toContain("requests");
      expect(processRun?.outputSchema).toMatchObject({ type: "object" });

      const result = await linked.client.callTool({ name: "workspace_list", arguments: {} });
      expect(result.structuredContent).toEqual(textData(result));
    } finally {
      await linked.close();
    }
  });

  it("shows request_user_input only to clients with form elicitation", async () => {
    const linked = await createLinkedClient([process.cwd()], "elicitation-visible", {
      action: "accept",
      value: "PostgreSQL",
    });
    try {
      const listed = await linked.client.listTools();
      expect(listed.tools).toHaveLength(24);
      expect(listed.tools.some((tool) => tool.name === "request_user_input")).toBe(true);

      const result = await linked.client.callTool({
        name: "request_user_input",
        arguments: {
          message: "Which database should I configure?",
          label: "Database",
          placeholder: "Enter a database name",
          minLength: 1,
          maxLength: 100,
        },
      });
      expect(textData(result)).toEqual({ action: "accept", value: "PostgreSQL" });
      expect(linked.lastElicitation()).toMatchObject({
        mode: "form",
        message: "Which database should I configure?",
        requestedSchema: {
          type: "object",
          required: ["value"],
          properties: {
            value: {
              type: "string",
              title: "Database",
              description: "Enter a database name",
              minLength: 1,
              maxLength: 100,
            },
          },
        },
      });
    } finally {
      await linked.close();
    }
  });

  it("preserves elicitation decline and cancel actions", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const linked = await createLinkedClient([process.cwd()], `elicitation-${action}`, { action });
      try {
        const result = await linked.client.callTool({
          name: "request_user_input",
          arguments: { message: "Choose a value" },
        });
        expect(textData(result)).toEqual({ action });
      } finally {
        await linked.close();
      }
    }
  });

  it("selects the first approved workspace when the previous selection is unavailable", async () => {
    const workspace = process.cwd();
    const firstWorkspace = path.dirname(workspace);
    const secondWorkspace = path.dirname(firstWorkspace);
    const linked = await createLinkedClient([firstWorkspace, secondWorkspace], "workspace-default");
    try {
      const listed = await linked.client.callTool({ name: "workspace_list", arguments: {} });
      expect(textData(listed)).toMatchObject({
        workspaces: [firstWorkspace, secondWorkspace],
        activeWorkspace: firstWorkspace,
      });
    } finally {
      await linked.close();
    }
  });

  it("shares the active workspace across independent MCP sessions", async () => {
    const workspace = process.cwd();
    const otherWorkspace = path.dirname(workspace);
    const first = await createLinkedClient([workspace, otherWorkspace], "global-workspace-a");
    const second = await createLinkedClient([workspace, otherWorkspace], "global-workspace-b");
    try {
      const setResult = await first.client.callTool({
        name: "workspace_set",
        arguments: { workspace: otherWorkspace },
      });
      expect(textData(setResult)).toMatchObject({ activeWorkspace: otherWorkspace, set: true });

      const listed = await second.client.callTool({ name: "workspace_list", arguments: {} });
      expect(textData(listed).activeWorkspace).toBe(otherWorkspace);
    } finally {
      await first.client.callTool({
        name: "workspace_set",
        arguments: { workspace },
      }).catch(() => undefined);
      await first.close();
      await second.close();
    }
  });
});
