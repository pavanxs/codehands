import assert from "node:assert/strict";
import * as path from "node:path";
import { CodexAdapter } from "../packages/codex-adapter/dist/index.js";
import { getHandler } from "../packages/mcp-tools/dist/index.js";

const workspace = path.resolve(".");
const adapter = new CodexAdapter();
const ownedProcesses = new Map();
const context = {
  adapter,
  activeWorkspace: workspace,
  workspaces: [workspace],
  resolvePath: (target) => path.resolve(workspace, target),
  ownedProcesses,
  sessionId: "correctness-smoke",
};

function parse(result) {
  return JSON.parse(result.content[0]?.text ?? "null");
}

function firstResult(result) {
  return parse(result).results[0];
}

async function call(name, args = {}) {
  const handler = getHandler(name);
  assert(handler, `Missing handler: ${name}`);
  return handler(args, context);
}

async function readUntilExit(processId) {
  let afterSeq;
  let output = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const item = firstResult(await call("process_read", {
      requests: [{ processId, afterSeq, waitMs: 1000 }],
    }));
    assert.equal(item.success, true, item.error?.message);
    output += item.chunks.map((chunk) => chunk.text).join("");
    afterSeq = item.nextAfterSeq;
    if (item.closed) return { ...item, output };
  }
  throw new Error(`Process did not exit: ${processId}`);
}

await adapter.start();
try {
  const walk = firstResult(await call("fs_walk", {
    requests: [{ path: "tests", maxDepth: 1 }],
  }));
  assert.equal(walk.success, true, walk.error?.message);

  const packageRead = firstResult(await call("fs_readFile", {
    requests: [{ path: "package.json" }],
  }));
  assert.equal(packageRead.success, true, packageRead.error?.message);
  assert.equal(packageRead.eof, true);
  assert.match(packageRead.content, /mcp-coding-harness/);

  const boundedRun = firstResult(await call("process_run", {
    requests: [{ command: "node", args: ["-p", "6 * 7"], shell: false }],
  }));
  assert.equal(boundedRun.success, true, boundedRun.error?.message);
  assert.equal(boundedRun.stdout.trim(), "42");
  assert.equal(boundedRun.exitCode, 0);

  const exact = firstResult(await call("process_start", {
    requests: [{
      command: "node",
      args: ["-p", "process.argv.slice(1).length", "A B"],
      shell: false,
    }],
  }));
  const exactResult = await readUntilExit(exact.processId);
  assert.equal(exactResult.output.trim(), "1");

  const packageManager = firstResult(await call("process_start", {
    requests: [{ command: "npm", args: ["--version"], shell: false }],
  }));
  const packageManagerResult = await readUntilExit(packageManager.processId);
  assert.equal(packageManagerResult.exitCode, 0);
  assert.match(packageManagerResult.output.trim(), /^\d+\.\d+/);

  const stdin = firstResult(await call("process_start", {
    requests: [{
      command: "node",
      args: ["-e", "process.stdin.once('data', d => { console.log(d.toString().trim()); process.exit(0); })"],
      shell: false,
    }],
  }));

  let writeStatus;
  for (let attempt = 0; attempt < 10; attempt++) {
    writeStatus = firstResult(await call("process_write", {
      requests: [{ processId: stdin.processId, input: "stdin-works\n" }],
    }));
    if (writeStatus.status === "accepted") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(writeStatus.status, "accepted");
  const stdinResult = await readUntilExit(stdin.processId);
  assert.match(stdinResult.output, /stdin-works/);

  {
    const signalProcess = firstResult(await call("process_start", {
      requests: [{
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000)"],
        shell: false,
      }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const signalItem = firstResult(await call("process_signal", {
      requests: [{ processId: signalProcess.processId, signal: "interrupt" }],
    }));
    if (!signalItem.success) {
      assert.equal(process.platform, "win32");
      assert.match(signalItem.error?.message ?? "", /not supported/i);
      await call("process_terminate", {
        requests: [{ processId: signalProcess.processId }],
      });
    }
    const interrupted = await readUntilExit(signalProcess.processId);
    assert.ok(interrupted.exited || interrupted.closed);
  }

  const batch = parse(await call("batch", {
    calls: [{ tool: "workspace_set", args: { workspace: "other" } }],
  }));
  assert.equal(batch.results[0].success, false);

  console.log("Correctness smoke test passed.");
} finally {
  for (const [processId, info] of ownedProcesses) {
    if (!info.exited) {
      try { await adapter.processTerminate({ processId }); } catch {}
    }
  }
  await adapter.stop();
}
