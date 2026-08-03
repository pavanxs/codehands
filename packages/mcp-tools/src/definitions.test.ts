import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "./definitions.js";

describe("TOOL_DEFINITIONS", () => {
  it("has exactly 24 tools", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(24);
  });

  it("uses only allowed MCP name characters and has no duplicates", () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_\-.]+$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it("declares input and output schemas for every tool", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema.type).toBe("object");
    }
  });

  it("contains the expected tool categories", () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith("fs_"))).toHaveLength(9);
    expect(names.filter((name) => name.startsWith("process_"))).toHaveLength(7);
    expect(names.filter((name) => name.startsWith("http_"))).toHaveLength(1);
    expect(names.filter((name) => name.startsWith("workspace_"))).toHaveLength(2);
    expect(names).toContain("process_run");
    expect(names).toContain("batch");
    expect(names).toEqual(expect.arrayContaining(["repo_query", "fs_applyPatch", "view_image", "request_user_input"]));
  });

  it("uses requests-only input for all migrated multi-item tools", () => {
    const migrated = [
      "fs_readFile",
      "fs_writeFile",
      "fs_createDirectory",
      "fs_readDirectory",
      "fs_walk",
      "fs_remove",
      "fs_copy",
      "fs_getMetadata",
      "process_run",
      "process_start",
      "process_read",
      "process_write",
      "process_signal",
      "process_terminate",
      "http_request",
    ];
    for (const name of migrated) {
      const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name)!;
      expect(definition.inputSchema.required).toContain("requests");
      const requests = (definition.inputSchema.properties as any).requests;
      expect(requests.minItems).toBe(1);
      expect(requests.maxItems).toBe(8);
    }
  });

  it("keeps interactive and repository tools singular", () => {
    for (const name of ["repo_query", "fs_applyPatch", "view_image", "request_user_input"]) {
      const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name)!;
      expect((definition.inputSchema.properties as any).requests).toBeUndefined();
    }
    const requestInput = TOOL_DEFINITIONS.find((tool) => tool.name === "request_user_input")!;
    expect(requestInput.outputSchema).toMatchObject({ required: ["action"] });
  });

  it("requires explicit process execution mode per request", () => {
    const processStart = TOOL_DEFINITIONS.find((tool) => tool.name === "process_start")!;
    const item = (processStart.inputSchema.properties as any).requests.items;
    expect(item.required).toEqual(["command", "shell"]);
    expect(item.properties.shell.type).toBe("boolean");
  });

  it("declares ordered decoded process_read chunks", () => {
    const processRead = TOOL_DEFINITIONS.find((tool) => tool.name === "process_read")!;
    const item = (processRead.outputSchema.properties as any).results.items;
    const chunk = item.properties.chunks.items;
    expect(chunk.required).toEqual(["seq", "stream", "text"]);
    expect(chunk.properties.stream.enum).toEqual(["stdout", "stderr", "pty"]);
    expect(item.properties.output).toBeUndefined();
  });

  it("declares bounded HTTP response bodies", () => {
    const http = TOOL_DEFINITIONS.find((tool) => tool.name === "http_request")!;
    const request = (http.inputSchema.properties as any).requests.items;
    const result = (http.outputSchema.properties as any).results.items;

    expect(request.properties.maxResponseBytes).toMatchObject({ minimum: 1, maximum: 60_000, default: 60_000 });
    expect(result.properties.returnedBytes.type).toBe("integer");
    expect(result.properties.totalBytes.type).toBe("integer");
    expect(result.properties.bodyTruncated.type).toBe("boolean");
  });

  it("does not expose tty on process_run requests", () => {
    const processRun = TOOL_DEFINITIONS.find((tool) => tool.name === "process_run")!;
    const item = (processRun.inputSchema.properties as any).requests.items;
    expect(item.properties.tty).toBeUndefined();
  });

  it("annotates destructive and read-only tools", () => {
    const destructive = TOOL_DEFINITIONS.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name);
    expect(destructive).toEqual(expect.arrayContaining([
      "fs_writeFile",
      "fs_remove",
      "process_run",
      "process_start",
      "process_terminate",
    ]));

    const readOnly = TOOL_DEFINITIONS.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name);
    expect(readOnly).toEqual(expect.arrayContaining([
      "fs_readFile",
      "fs_readDirectory",
      "fs_walk",
      "process_read",
      "workspace_list",
    ]));
  });
});
