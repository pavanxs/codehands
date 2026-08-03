import { describe, expect, it } from "vitest";
import { formatLiveLogLine, formatParams } from "./logs.js";

describe("codehands logs formatting", () => {
  it("renders a detailed MCP call as one human-readable line", () => {
    const formatted = formatLiveLogLine(
      {
        timestamp: "2026-08-02T00:00:01.250Z",
        sessionId: "session-123",
        tool: "fs_readFile",
        params: {
          path: "README.md",
          options: { encoding: "utf8" },
          args: ["one", "two"],
        },
        durationMs: 17,
        success: true,
      },
      Date.parse("2026-08-02T00:00:00.000Z"),
      4,
    );

    expect(formatted.line).toContain("call 4");
    expect(formatted.line).toContain("idle 1.233s");
    expect(formatted.line).toContain("OK");
    expect(formatted.line).toContain("fs_readFile");
    expect(formatted.line).toContain("took 17ms");
    expect(formatted.line).toContain("session session-123");
    expect(formatted.line).toContain("path=README.md");
    expect(formatted.line).toContain("options.encoding=utf8");
    expect(formatted.line).toContain("args=one, two");
    expect(formatted.line).not.toMatch(/[\r\n{}]/);
    expect(formatted.detailLines).toEqual([]);
  });

  it("collapses multiline errors and replaces hard-to-read braces", () => {
    const formatted = formatLiveLogLine(
      {
        timestamp: "2026-08-02T00:00:02.000Z",
        tool: "process_start",
        params: { command: "node", payload: "{test}" },
        durationMs: 9,
        success: false,
        error: "first line\nsecond line {details}",
      },
      null,
      1,
    );

    expect(formatted.line).toContain("ERROR");
    expect(formatted.line).toContain("first line second line (details)");
    expect(formatted.line).toContain("payload=(test)");
    expect(formatted.line).not.toMatch(/[\r\n{}]/);
  });

  it("renders each request from a multi-file read on its own line", () => {
    const formatted = formatLiveLogLine(
      {
        timestamp: "2026-08-02T00:00:03.000Z",
        sessionId: "multi-read",
        tool: "fs_readFile",
        params: {
          requests: [
            { path: "src/a.ts", fromLine: 1, toLine: 20 },
            { path: "src/b.ts" },
            { path: "src/c.ts" },
            { path: "src/d.ts" },
            { path: "src/e.ts" },
          ],
        },
        durationMs: 25,
        success: true,
      },
      null,
      2,
    );

    expect(formatted.line).toContain("fs_readFile");
    expect(formatted.line).toContain("requests=5");
    expect(formatted.line).not.toContain("requests.1.path");
    expect(formatted.detailLines).toEqual([
      "  request 1 | path=src/a.ts | fromLine=1 | toLine=20",
      "  request 2 | path=src/b.ts",
      "  request 3 | path=src/c.ts",
      "  request 4 | path=src/d.ts",
      "  request 5 | path=src/e.ts",
    ]);
    expect(formatted.detailLines.every((line) => !/[\r\n{}]/.test(line))).toBe(true);
  });

  it("renders every batch edit as a separate call line", () => {
    const formatted = formatLiveLogLine(
      {
        timestamp: "2026-08-02T00:00:04.000Z",
        sessionId: "batch-edits",
        tool: "batch",
        params: {
          calls: [
            { tool: "fs_writeFile", args: { requests: [{ path: "src/a.ts", content: "[120 chars]" }] } },
            { tool: "fs_writeFile", args: { requests: [{ path: "src/b.ts", content: "[80 chars]" }] } },
            { tool: "fs_remove", args: { requests: [{ path: "src/old.ts", force: true }] } },
          ],
        },
        durationMs: 31,
        success: true,
      },
      null,
      3,
    );

    expect(formatted.line).toContain("batch");
    expect(formatted.line).toContain("calls=3");
    expect(formatted.detailLines).toEqual([
      "  call 1 | fs_writeFile | path=src/a.ts | content=[120 chars]",
      "  call 2 | fs_writeFile | path=src/b.ts | content=[80 chars]",
      "  call 3 | fs_remove | path=src/old.ts | force=true",
    ]);
    expect(formatted.detailLines.join("\n")).not.toContain("requests.1");
  });

  it("nests individual requests below a batch call that contains multiple requests", () => {
    const formatted = formatLiveLogLine(
      {
        tool: "batch",
        params: {
          calls: [
            {
              tool: "fs_readFile",
              args: { requests: [{ path: "one.ts" }, { path: "two.ts" }] },
            },
          ],
        },
        success: true,
      },
      null,
      4,
    );

    expect(formatted.detailLines).toEqual([
      "  call 1 | fs_readFile | requests=2",
      "    request 1 | path=one.ts",
      "    request 2 | path=two.ts",
    ]);
  });

  it("keeps a single requests-array item on the main call line", () => {
    const formatted = formatLiveLogLine(
      {
        tool: "fs_readFile",
        params: { requests: [{ path: "README.md", fromLine: 1, toLine: 5 }] },
        success: true,
      },
      null,
      5,
    );

    expect(formatted.line).toContain("path=README.md | fromLine=1 | toLine=5");
    expect(formatted.line).not.toContain("requests.1");
    expect(formatted.detailLines).toEqual([]);
  });

  it("labels process_read duration as intentional long polling", () => {
    const formatted = formatLiveLogLine(
      {
        timestamp: "2026-08-02T00:02:00.000Z",
        startedAt: "2026-08-02T00:00:21.288Z",
        tool: "process_read",
        params: { requests: [{ processId: "proc-1", waitMs: 120000 }] },
        durationMs: 98_712,
        success: true,
      },
      Date.parse("2026-08-02T00:00:20.000Z"),
      6,
    );

    expect(formatted.line).toContain("idle 1.288s");
    expect(formatted.line).toContain("long-poll 98.712s");
    expect(formatted.line).not.toContain("gap");
  });

  it("shows nested batch timing and timed-out child status", () => {
    const formatted = formatLiveLogLine(
      {
        timestamp: "2026-08-02T00:03:00.000Z",
        startedAt: "2026-08-02T00:02:00.000Z",
        tool: "batch",
        params: {
          calls: [
            {
              tool: "process_run",
              args: {
                requests: [
                  { command: "pnpm", args: ["build"], shell: false },
                  { command: "cargo", args: ["check"], shell: false },
                ],
              },
            },
            { tool: "fs_readFile", args: { requests: [{ path: "README.md" }] } },
          ],
        },
        durationMs: 60_000,
        success: true,
        outcome: {
          results: [
            {
              index: 0,
              tool: "process_run",
              success: true,
              durationMs: 60_000,
              children: [
                { index: 0, success: true, status: "succeeded", durationMs: 9_000, exitCode: 0 },
                { index: 1, success: false, status: "timed_out", durationMs: 60_000, timedOut: true },
              ],
            },
            { index: 1, tool: "fs_readFile", success: true, durationMs: 20 },
          ],
        },
      },
      null,
      7,
    );

    expect(formatted.line).toContain("PARTIAL");
    expect(formatted.line).toContain("elapsed 60.000s");
    expect(formatted.detailLines).toEqual([
      "  call 1 | process_run | requests=2 | PARTIAL | active 60.000s",
      "    request 1 | command=pnpm | args=build | shell=false | OK | active 9.000s | exit 0",
      "    request 2 | command=cargo | args=check | shell=false | TIMEOUT | active 60.000s",
      "  call 2 | fs_readFile | path=README.md | OK | active 20ms",
    ]);
  });

  it("prints a timed-out single request below its batch call", () => {
    const formatted = formatLiveLogLine(
      {
        tool: "batch",
        params: {
          calls: [
            {
              tool: "process_run",
              args: { requests: [{ command: "node", args: ["slow.js"], shell: false, timeoutMs: 100 }] },
            },
          ],
        },
        durationMs: 250,
        success: true,
        outcome: {
          results: [
            {
              index: 0,
              tool: "process_run",
              success: true,
              durationMs: 250,
              children: [
                { index: 0, success: false, status: "timed_out", durationMs: 125, timedOut: true },
              ],
            },
          ],
        },
      },
      null,
      8,
    );

    expect(formatted.line).toContain("ERROR");
    expect(formatted.detailLines).toEqual([
      "  call 1 | process_run | ERROR | active 250ms",
      "    request 1 | command=node | args=slow.js | shell=false | timeoutMs=100 | TIMEOUT | active 125ms",
    ]);
  });

  it("flattens nested parameters without JSON syntax", () => {
    const params = formatParams({
      request: {
        headers: { accept: "application/json" },
        retries: 2,
      },
    });

    expect(params).toBe("request.headers.accept=application/json | request.retries=2");
    expect(params).not.toMatch(/[{}]/);
  });
});
