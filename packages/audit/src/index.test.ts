import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AuditLogger } from "./index.js";

const TEST_DIR = path.join(os.tmpdir(), "codehands-audit-test-" + Date.now());

afterEach(async () => {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
});

describe("AuditLogger", () => {
  it("writes log entries as JSONL", async () => {
    const logger = new AuditLogger({ logDir: TEST_DIR });

    logger.log({
      timestamp: "2025-01-01T00:00:00.012Z",
      startedAt: "2025-01-01T00:00:00.000Z",
      sessionId: "sess-1",
      tool: "fs_readFile",
      params: { path: "/home/user/file.txt" },
      durationMs: 12,
      success: true,
      outcome: { results: [{ index: 0, success: true, durationMs: 12 }] },
    });

    await logger.close();

    const files = fs.readdirSync(TEST_DIR);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.jsonl$/);

    const content = fs.readFileSync(path.join(TEST_DIR, files[0]), "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.tool).toBe("fs_readFile");
    expect(entry.success).toBe(true);
    expect(entry.durationMs).toBe(12);
    expect(entry.startedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(entry.outcome.results[0]).toMatchObject({ success: true, durationMs: 12 });
  });

  it("does nothing when disabled", async () => {
    const logger = new AuditLogger({ enabled: false, logDir: TEST_DIR });

    logger.log({
      timestamp: "2025-01-01T00:00:00.000Z",
      sessionId: "sess-1",
      tool: "process_start",
      params: { command: "npm test" },
      durationMs: 5,
      success: true,
    });

    await logger.close();

    const exists = fs.existsSync(TEST_DIR);
    expect(exists).toBe(false);
  });

  it("redacts content when configured", async () => {
    const logger = new AuditLogger({ logDir: TEST_DIR, redactContent: true });

    logger.log({
      timestamp: "2025-01-01T00:00:00.000Z",
      sessionId: "sess-2",
      tool: "fs_writeFile",
      params: { path: "/file.txt", content: "SECRET DATA" },
      durationMs: 8,
      success: true,
    });

    await logger.close();

    const files = fs.readdirSync(TEST_DIR);
    const content = fs.readFileSync(path.join(TEST_DIR, files[0]), "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.params.content).toBe("[11 chars]");
    expect(entry.params.path).toBe("/file.txt");
  });

  it("redacts patch bodies", async () => {
    const logger = new AuditLogger({ logDir: TEST_DIR, redactContent: true });
    logger.log({
      timestamp: "2025-01-01T00:00:00.000Z",
      sessionId: "sess-patch",
      tool: "fs_applyPatch",
      params: { cwd: ".", patch: "*** Begin Patch\n*** End Patch" },
      durationMs: 1,
      success: false,
    });
    await logger.close();
    const files = fs.readdirSync(TEST_DIR);
    const content = fs.readFileSync(path.join(TEST_DIR, files[0]), "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.params.patch).toBe("[29 chars]");
    expect(entry.params.cwd).toBe(".");
  });

  it("redacts nested headers, environment values, and stdin", async () => {
    const logger = new AuditLogger({ logDir: TEST_DIR, redactContent: true });

    logger.log({
      timestamp: "2025-01-01T00:00:00.000Z",
      sessionId: "sess-secret",
      tool: "batch",
      params: {
        env: { API_TOKEN: "secret" },
        headers: { Authorization: "Bearer secret" },
        calls: [{ tool: "process_write", args: { input: "password" } }],
      },
      durationMs: 1,
      success: true,
    });

    await logger.close();

    const files = fs.readdirSync(TEST_DIR);
    const content = fs.readFileSync(path.join(TEST_DIR, files[0]), "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.params.env.API_TOKEN).toBe("[redacted]");
    expect(entry.params.headers.Authorization).toBe("[redacted]");
    expect(entry.params.calls[0].args.input).toBe("[8 chars]");
  });

  it("logs errors", async () => {
    const logger = new AuditLogger({ logDir: TEST_DIR });

    logger.log({
      timestamp: "2025-01-01T00:00:00.000Z",
      sessionId: "sess-1",
      tool: "process_start",
      params: { command: "rm -rf /" },
      durationMs: 1,
      success: false,
      error: "Command blocked by safety policy",
    });

    await logger.close();

    const files = fs.readdirSync(TEST_DIR);
    const content = fs.readFileSync(path.join(TEST_DIR, files[0]), "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.success).toBe(false);
    expect(entry.error).toContain("blocked");
  });
});
