import { describe, expect, it } from "vitest";
import * as path from "node:path";
import type { CodexAdapter } from "@codehands/codex-adapter";
import { getHandler, type ToolContext, type ToolResult } from "./handlers.js";

function parse(result: ToolResult): any {
  return JSON.parse(result.content.find((item) => item.type === "text")?.text ?? "null");
}

function defaultShell() {
  if (process.platform === "win32") {
    return {
      name: "powershell" as const,
      path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    };
  }
  if (process.platform === "darwin") return { name: "zsh" as const, path: "/bin/zsh" };
  return { name: "bash" as const, path: "/bin/bash" };
}

function createContext(adapter: Partial<CodexAdapter>, checkBlocked?: ToolContext["checkBlocked"]): ToolContext {
  const workspace = process.cwd();
  const defaults: Partial<CodexAdapter> = {
    getEnvironmentInfo: async () => ({ shell: defaultShell() }),
    fsGetMetadata: async ({ path: uri }: { path: string }) => {
      if (!/node\.exe|git\.exe|npm\.cmd|powershell\.exe/i.test(uri)) throw new Error("not found");
      return {
        isDirectory: false,
        isFile: true,
        isSymlink: false,
        size: 1,
        createdAtMs: 0,
        modifiedAtMs: 0,
      };
    },
  };
  return {
    adapter: { ...defaults, ...adapter } as CodexAdapter,
    activeWorkspace: workspace,
    workspaces: [workspace],
    resolvePath: (target) => path.resolve(workspace, target),
    ownedProcesses: new Map(),
    sessionId: "test-session",
    checkBlocked,
  };
}

function addOwnedProcess(ctx: ToolContext, processId: string, exited = false) {
  ctx.ownedProcesses.set(processId, {
    command: "test",
    argv: ["test"],
    mode: "direct",
    tty: false,
    startedAt: new Date().toISOString(),
    exited,
    sessionId: ctx.sessionId,
  });
}

function createFileAdapter(content: string): Partial<CodexAdapter> {
  const bytes = Buffer.from(content, "utf-8");
  return {
    fsOpen: async ({ handleId }: { handleId: string }) => ({ handleId }),
    fsReadBlock: async ({ offset, len }: { offset: number; len: number }) => {
      const chunk = bytes.subarray(offset, offset + len);
      return {
        chunk: chunk.toString("base64"),
        eof: offset + chunk.length >= bytes.length,
      };
    },
    fsClose: async () => ({}),
  };
}

function createBinaryFileAdapter(bytes: Buffer): Partial<CodexAdapter> {
  return {
    fsGetMetadata: async () => ({
      isDirectory: false,
      isFile: true,
      isSymlink: false,
      size: bytes.length,
      createdAtMs: 0,
      modifiedAtMs: 0,
    }),
    fsOpen: async ({ handleId }: { handleId: string }) => ({ handleId }),
    fsReadBlock: async ({ offset, len }: { offset: number; len: number }) => {
      const chunk = bytes.subarray(offset, offset + len);
      return { chunk: chunk.toString("base64"), eof: offset + chunk.length >= bytes.length };
    },
    fsClose: async () => ({}),
  };
}

describe("MCP handlers", () => {
  it("uses an exact absolute workspace path before basename matching", async () => {
    const outer = path.join(process.cwd(), "same-name");
    const inner = path.join(outer, "same-name");
    const ctx = createContext({});
    ctx.workspaces = [inner, outer];
    ctx.activeWorkspace = inner;

    const result = await getHandler("workspace_set")!({ workspace: outer }, ctx);

    expect(result.isError).not.toBe(true);
    expect(parse(result)).toEqual({ activeWorkspace: outer, set: true });
    expect(ctx.activeWorkspace).toBe(outer);
  });

  it("marks structured fs_applyPatch rejections as MCP errors", async () => {
    const helperResult = {
      success: false,
      dryRun: false,
      partialApplied: false,
      changes: [],
      error: { code: "PATCH_OVERWRITE_REJECTED", message: "target exists" },
    };
    const ctx = createContext({
      fsGetMetadata: async () => ({
        isDirectory: false,
        isFile: true,
        isSymlink: false,
        size: 1,
        createdAtMs: 0,
        modifiedAtMs: 0,
      }),
      processStart: async () => ({ processId: "patch-helper" }),
      processWrite: async () => ({ status: "accepted" }),
      processRead: async () => ({
        chunks: [{ seq: 1, stream: "stdout", chunk: Buffer.from(JSON.stringify(helperResult)).toString("base64") }],
        nextSeq: 2,
        exited: true,
        exitCode: 1,
        closed: true,
        failure: null,
        sandboxDenied: false,
      }),
    });

    const result = await getHandler("fs_applyPatch")!({
      patch: "*** Begin Patch\n*** Add File: existing.txt\n+new\n*** End Patch",
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(helperResult);
    expect(parse(result)).toEqual(helperResult);
  });

  it("returns the same object as JSON text and structuredContent", async () => {
    const ctx = createContext({ fsWriteFile: async () => ({}) });
    const result = await getHandler("fs_writeFile")!({
      requests: [{ path: "a.txt", content: "hello" }],
    }, ctx);

    expect(result.structuredContent).toEqual(parse(result));
    expect(parse(result).results[0]).toMatchObject({ success: true, written: true });
  });

  it("rejects the legacy singular input form", async () => {
    const ctx = createContext({});
    const result = await getHandler("fs_readDirectory")!({ path: "." }, ctx);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]?.text).toContain("requests");
  });

  it("reads a whole small file when line options are omitted", async () => {
    const ctx = createContext(createFileAdapter("one\ntwo\n"));
    const data = parse(await getHandler("fs_readFile")!({
      requests: [{ path: "small.txt" }],
    }, ctx));

    expect(data.results[0]).toMatchObject({
      success: true,
      mode: "line",
      content: "one\ntwo\n",
      fromLine: 1,
      toLine: 2,
      eof: true,
      totalLines: 2,
    });
    expect(data.results[0].nextFromLine).toBeUndefined();
  });

  it("returns a directly reusable line continuation", async () => {
    const ctx = createContext(createFileAdapter("first\nsecond\nthird\n"));
    const first = parse(await getHandler("fs_readFile")!({
      requests: [{ path: "large.txt", maxChars: 6 }],
    }, ctx)).results[0];

    expect(first).toMatchObject({ content: "first\n", eof: false, nextFromLine: 2 });

    const second = parse(await getHandler("fs_readFile")!({
      requests: [{ path: "large.txt", fromLine: first.nextFromLine, maxChars: 7 }],
    }, ctx)).results[0];
    expect(second.content).toBe("second\n");
    expect(second.nextFromLine).toBe(3);
  });

  it("returns byte continuation using nextOffset", async () => {
    const ctx = createContext(createFileAdapter("abcdef"));
    const data = parse(await getHandler("fs_readFile")!({
      requests: [{ path: "bytes.txt", offset: 1, maxBytes: 3 }],
    }, ctx)).results[0];

    expect(data).toMatchObject({
      mode: "byte",
      content: "bcd",
      offset: 1,
      returnedBytes: 3,
      eof: false,
      nextOffset: 4,
    });
  });

  it("runs read-only requests concurrently but preserves result order", async () => {
    const completion: string[] = [];
    const ctx = createContext({
      fsGetMetadata: async ({ path: uri }: { path: string }) => {
        const slow = uri.includes("slow");
        await new Promise((resolve) => setTimeout(resolve, slow ? 30 : 1));
        completion.push(slow ? "slow" : "fast");
        return {
          isDirectory: false,
          isFile: true,
          isSymlink: false,
          size: slow ? 1 : 2,
          createdAtMs: 0,
          modifiedAtMs: 0,
        };
      },
    });

    const data = parse(await getHandler("fs_getMetadata")!({
      requests: [{ path: "slow.txt" }, { path: "fast.txt" }],
    }, ctx));

    expect(completion).toEqual(["fast", "slow"]);
    expect(data.results.map((item: any) => path.basename(item.path))).toEqual(["slow.txt", "fast.txt"]);
  });

  it("supports eight file reads while keeping returned content within the shared response budget", async () => {
    const content = Array.from({ length: 200 }, (_, index) => `line-${index.toString().padStart(3, "0")}-${"x".repeat(80)}\n`).join("");
    const ctx = createContext(createFileAdapter(content));
    const data = parse(await getHandler("fs_readFile")!({
      requests: Array.from({ length: 8 }, (_, index) => ({ path: `file-${index}.txt` })),
    }, ctx));

    expect(data.results).toHaveLength(8);
    expect(data.results.every((item: any) => item.success)).toBe(true);
    expect(data.results.reduce((total: number, item: any) => total + item.content.length, 0)).toBeLessThanOrEqual(60_000);
    expect(data.results.every((item: any) => item.eof === false && item.nextFromLine > 1)).toBe(true);
  });

  it("keeps partial failures inside the results envelope", async () => {
    const ctx = createContext({
      fsReadDirectory: async ({ path: uri }: { path: string }) => {
        if (uri.includes("missing")) throw new Error("not found");
        return { entries: [] };
      },
    });

    const data = parse(await getHandler("fs_readDirectory")!({
      requests: [{ path: "ok" }, { path: "missing" }],
    }, ctx));

    expect(data.results[0].success).toBe(true);
    expect(data.results[1]).toMatchObject({
      success: false,
      error: { code: "FS_READ_DIRECTORY_FAILED", message: "not found" },
    });
  });

  it("executes state-changing file requests sequentially", async () => {
    const order: string[] = [];
    const ctx = createContext({
      fsWriteFile: async ({ path: uri }: { path: string }) => {
        order.push(`start:${path.basename(new URL(uri).pathname)}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end:${path.basename(new URL(uri).pathname)}`);
        return {};
      },
    });

    await getHandler("fs_writeFile")!({
      requests: [
        { path: "one.txt", content: "1" },
        { path: "two.txt", content: "2" },
      ],
    }, ctx);

    expect(order).toEqual(["start:one.txt", "end:one.txt", "start:two.txt", "end:two.txt"]);
  });

  it("starts multiple processes sequentially with exact arguments", async () => {
    const received: any[] = [];
    const ctx = createContext({
      processStart: async (params: any) => {
        received.push(params);
        return { processId: `proc-${received.length}` };
      },
    });

    const data = parse(await getHandler("process_start")!({
      requests: [
        { command: "node", args: ["-p", "1 + 1"], shell: false },
        { command: "node", args: ["-p", "2 + 2"], shell: false },
      ],
    }, ctx));

    expect(data.results.map((item: any) => item.processId)).toEqual(["proc-1", "proc-2"]);
    expect(received[0].argv.slice(-2)).toEqual(["-p", "1 + 1"]);
    expect(received[1].argv.slice(-2)).toEqual(["-p", "2 + 2"]);
  });

  it("reads multiple processes concurrently while preserving request order", async () => {
    const completion: string[] = [];
    const maxBytesSeen: number[] = [];
    const ctx = createContext({
      processRead: async ({ processId, maxBytes }: { processId: string; maxBytes?: number }) => {
        maxBytesSeen.push(maxBytes ?? 0);
        const slow = processId === "proc-slow";
        await new Promise((resolve) => setTimeout(resolve, slow ? 30 : 1));
        completion.push(processId);
        return {
          chunks: [],
          nextSeq: 1,
          exited: false,
          exitCode: null,
          closed: false,
          failure: null,
          sandboxDenied: false,
        };
      },
    });
    addOwnedProcess(ctx, "proc-slow");
    addOwnedProcess(ctx, "proc-fast");

    const data = parse(await getHandler("process_read")!({
      requests: [
        { processId: "proc-slow", waitMs: 30 },
        { processId: "proc-fast", waitMs: 1 },
      ],
    }, ctx));

    expect(completion).toEqual(["proc-fast", "proc-slow"]);
    expect(maxBytesSeen).toEqual([30_000, 30_000]);
    expect(data.results.map((item: any) => item.processId)).toEqual(["proc-slow", "proc-fast"]);
  });

  it("returns ordered decoded process chunks without an aggregated output field", async () => {
    const ctx = createContext({
      processRead: async () => ({
        chunks: [
          { seq: 4, stream: "stdout", chunk: Buffer.from("out\n").toString("base64") },
          { seq: 5, stream: "stderr", chunk: Buffer.from("warn\n").toString("base64") },
        ],
        nextSeq: 6,
        exited: false,
        exitCode: null,
        closed: false,
        failure: null,
        sandboxDenied: false,
      }),
    });
    addOwnedProcess(ctx, "proc-1");

    const item = parse(await getHandler("process_read")!({
      requests: [{ processId: "proc-1" }],
    }, ctx)).results[0];

    expect(item.chunks).toEqual([
      { seq: 4, stream: "stdout", text: "out\n" },
      { seq: 5, stream: "stderr", text: "warn\n" },
    ]);
    expect(item.nextAfterSeq).toBe(5);
    expect(item.output).toBeUndefined();
  });

  it("records elapsed time for every batch child", async () => {
    const ctx = createContext({
      processRead: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          chunks: [],
          nextSeq: 1,
          exited: false,
          exitCode: null,
          closed: false,
          failure: null,
          sandboxDenied: false,
        };
      },
    });
    addOwnedProcess(ctx, "proc-batch");

    const data = parse(await getHandler("batch")!({
      calls: [
        { tool: "process_read", args: { requests: [{ processId: "proc-batch", waitMs: 15 }] } },
        { tool: "unknown_tool", args: {} },
      ],
    }, ctx));

    expect(data.results[0]).toMatchObject({ index: 0, tool: "process_read", success: true });
    expect(data.results[0].durationMs).toBeGreaterThanOrEqual(10);
    expect(data.results[1]).toMatchObject({ index: 1, tool: "unknown_tool", success: false });
    expect(typeof data.results[1].durationMs).toBe("number");
  });

  it("runs a bounded command and keeps stdout and stderr separate", async () => {
    const ctx = createContext({
      processStart: async () => ({ processId: "proc-run" }),
      processRead: async () => ({
        chunks: [
          { seq: 1, stream: "stdout", chunk: Buffer.from("ok").toString("base64") },
          { seq: 2, stream: "stderr", chunk: Buffer.from("note").toString("base64") },
        ],
        nextSeq: 3,
        exited: true,
        exitCode: 0,
        closed: true,
        failure: null,
        sandboxDenied: false,
      }),
    });

    const item = parse(await getHandler("process_run")!({
      requests: [{ command: "node", args: ["-e", ""], shell: false }],
    }, ctx)).results[0];

    expect(item).toMatchObject({
      status: "succeeded",
      success: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "note",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    expect(item.processId).toBeUndefined();
  });

  it("reports a non-zero process_run exit as a per-item failure", async () => {
    const ctx = createContext({
      processStart: async () => ({ processId: "proc-failed" }),
      processRead: async () => ({
        chunks: [{ seq: 1, stream: "stderr", chunk: Buffer.from("bad").toString("base64") }],
        nextSeq: 2,
        exited: true,
        exitCode: 7,
        closed: true,
        failure: null,
        sandboxDenied: false,
      }),
    });

    const item = parse(await getHandler("process_run")!({
      requests: [{ command: "node", args: [], shell: false }],
    }, ctx)).results[0];

    expect(item).toMatchObject({
      success: false,
      status: "failed",
      exitCode: 7,
      stderr: "bad",
      error: { code: "PROCESS_EXIT_NON_ZERO" },
    });
  });

  it("rejects process_run parallel concurrency above three", async () => {
    const ctx = createContext({});
    const result = await getHandler("process_run")!({
      requests: [{ command: "node", args: [], shell: false }],
      execution: "parallel",
      maxConcurrency: 4,
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("between 1 and 3");
  });

  it("rejects process_run timeouts above 60 seconds before launch", async () => {
    let started = false;
    const ctx = createContext({
      processStart: async () => {
        started = true;
        return { processId: "bad" };
      },
    });

    const item = parse(await getHandler("process_run")!({
      requests: [{ command: "node", args: [], shell: false, timeoutMs: 60_001 }],
    }, ctx)).results[0];

    expect(started).toBe(false);
    expect(item.success).toBe(false);
    expect(item.error.message).toContain("at most 60000 ms");
  });

  it("terminates a process when process_run cannot read its result", async () => {
    let terminated = false;
    const ctx = createContext({
      processStart: async () => ({ processId: "proc-read-failure" }),
      processRead: async () => { throw new Error("read connection failed"); },
      processTerminate: async () => {
        terminated = true;
        return { running: true };
      },
    });

    const item = parse(await getHandler("process_run")!({
      requests: [{ command: "node", args: [], shell: false }],
    }, ctx)).results[0];

    expect(terminated).toBe(true);
    expect(item).toMatchObject({
      success: false,
      status: "failed",
      error: { code: "PROCESS_RUN_FAILED", message: "read connection failed" },
    });
  });

  it("terminates process_run on timeout", async () => {
    let terminated = false;
    const ctx = createContext({
      processStart: async () => ({ processId: "proc-timeout" }),
      processRead: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          chunks: [],
          nextSeq: 1,
          exited: false,
          exitCode: null,
          closed: false,
          failure: null,
          sandboxDenied: false,
        };
      },
      processTerminate: async () => {
        terminated = true;
        return { running: true };
      },
    });

    const item = parse(await getHandler("process_run")!({
      requests: [{ command: "node", args: [], shell: false, timeoutMs: 100 }],
    }, ctx)).results[0];

    expect(terminated).toBe(true);
    expect(item).toMatchObject({
      success: false,
      status: "timed_out",
      timedOut: true,
      error: { code: "PROCESS_RUN_TIMEOUT" },
    });
  });

  it("returns a structured error when process input is not accepted", async () => {
    const ctx = createContext({
      processWrite: async () => ({ status: "stdinClosed" }),
    });
    addOwnedProcess(ctx, "proc-closed");

    const item = parse(await getHandler("process_write")!({
      requests: [{ processId: "proc-closed", input: "hello" }],
    }, ctx)).results[0];

    expect(item).toMatchObject({
      success: false,
      status: "stdinClosed",
      error: { code: "PROCESS_WRITE_REJECTED" },
    });
  });

  it("bounds buffered HTTP response bodies and reports truncation", async () => {
    const ctx = createContext({
      httpRequest: async () => ({
        status: 200,
        headers: [{ name: "content-type", value: "text/plain" }],
        bodyBase64: Buffer.from("abcdefghij").toString("base64"),
      }),
    });

    const item = parse(await getHandler("http_request")!({
      requests: [{ method: "GET", url: "https://example.test", maxResponseBytes: 4 }],
    }, ctx)).results[0];

    expect(item).toMatchObject({
      success: true,
      status: 200,
      body: "abcd",
      returnedBytes: 4,
      totalBytes: 10,
      bodyTruncated: true,
    });
  });

  it("uses nested structuredContent in batch results", async () => {
    const ctx = createContext({ fsReadDirectory: async () => ({ entries: [] }) });
    const data = parse(await getHandler("batch")!({
      calls: [{ tool: "fs_readDirectory", args: { requests: [{ path: "." }] } }],
    }, ctx));

    expect(data.results[0].data.results[0].success).toBe(true);
  });
  it("returns validated MCP image content", async () => {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
    bytes.writeUInt32BE(4, 16);
    bytes.writeUInt32BE(3, 20);
    const ctx = createContext(createBinaryFileAdapter(bytes));
    const result = await getHandler("view_image")!({ path: "image.png" }, ctx);

    expect(result.structuredContent).toMatchObject({
      success: true,
      mimeType: "image/png",
      bytes: 24,
      width: 4,
      height: 3,
    });
    expect(result.content.find((item) => item.type === "image")).toEqual({
      type: "image",
      data: bytes.toString("base64"),
      mimeType: "image/png",
    });
  });

  it("returns accepted user input through the custom callback", async () => {
    const ctx = createContext({});
    let captured: unknown;
    ctx.requestUserInput = async (prompt) => {
      captured = prompt;
      return { action: "accept", value: "PostgreSQL" };
    };
    const data = parse(await getHandler("request_user_input")!({
      message: "Which database?",
      label: "Database",
      minLength: 1,
      maxLength: 100,
    }, ctx));

    expect(data).toEqual({ action: "accept", value: "PostgreSQL" });
    expect(captured).toMatchObject({ message: "Which database?", label: "Database", required: true });
  });

  it("rejects secret prompts and interactive batch calls", async () => {
    const ctx = createContext({});
    ctx.requestUserInput = async () => ({ action: "accept", value: "hidden" });
    const secret = await getHandler("request_user_input")!({ message: "Enter your API key" }, ctx);
    expect(secret.isError).toBe(true);
    expect(secret.content.find((item) => item.type === "text")?.text).toContain("cannot be used to request secrets");

    const batched = parse(await getHandler("batch")!({
      calls: [{ tool: "request_user_input", args: { message: "Choose" } }],
    }, ctx));
    expect(batched.results[0]).toMatchObject({ success: false, error: "request_user_input cannot run inside batch" });
  });

});
