import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const executable = path.resolve(
  "native/codehands-apply-patch/bin",
  process.platform === "win32" ? "codehands-apply-patch.exe" : "codehands-apply-patch",
);

assert.ok(fs.existsSync(executable), `Patch helper is missing: ${executable}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codehands-patch-helper-"));
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace, { recursive: true });

function run(patch, options = {}) {
  const request = {
    version: 1,
    patch,
    cwd: workspace,
    workspaceRoots: [workspace],
    dryRun: false,
    allowOverwrite: false,
    preserveLineEndings: true,
    maxFiles: 50,
    ...options,
  };
  const result = spawnSync(executable, [], {
    cwd: workspace,
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  const line = result.stdout.trim();
  assert.ok(line, `Helper returned no JSON. stderr: ${result.stderr}`);
  return { status: result.status, stderr: result.stderr, data: JSON.parse(line) };
}

try {
  const dryRun = run("*** Begin Patch\n*** Add File: dry.txt\n+dry\n*** End Patch", { dryRun: true });
  assert.equal(dryRun.status, 0);
  assert.equal(dryRun.data.success, true);
  assert.equal(dryRun.data.dryRun, true);
  assert.equal(fs.existsSync(path.join(workspace, "dry.txt")), false);
  assert.equal(dryRun.data.changes[0].operation, "add");

  const add = run("*** Begin Patch\n*** Add File: created.txt\n+created\n*** End Patch");
  assert.equal(add.status, 0);
  assert.equal(add.data.success, true);
  assert.equal(fs.readFileSync(path.join(workspace, "created.txt"), "utf8"), "created\n");

  const traversal = run("*** Begin Patch\n*** Add File: ../outside.txt\n+escaped\n*** End Patch");
  assert.equal(traversal.status, 1);
  assert.equal(traversal.data.success, false);
  assert.equal(traversal.data.error.code, "PATCH_PATH_INVALID");
  assert.equal(fs.existsSync(path.join(root, "outside.txt")), false);

  const absolutePath = path.join(root, "absolute.txt");
  const absolute = run(`*** Begin Patch\n*** Add File: ${absolutePath}\n+absolute\n*** End Patch`);
  assert.equal(absolute.status, 1);
  assert.equal(absolute.data.error.code, "PATCH_PATH_INVALID");
  assert.equal(fs.existsSync(absolutePath), false);

  fs.writeFileSync(path.join(workspace, "existing.txt"), "old\n");
  const overwrite = run("*** Begin Patch\n*** Add File: existing.txt\n+new\n*** End Patch");
  assert.equal(overwrite.status, 1);
  assert.equal(overwrite.data.error.code, "PATCH_OVERWRITE_REJECTED");
  assert.equal(fs.readFileSync(path.join(workspace, "existing.txt"), "utf8"), "old\n");

  fs.writeFileSync(path.join(workspace, "crlf.txt"), "a\r\nb\r\n");
  const crlf = run("*** Begin Patch\n*** Update File: crlf.txt\n@@\n-b\n+c\n*** End Patch");
  assert.equal(crlf.status, 0);
  assert.equal(crlf.data.success, true);
  assert.deepEqual([...fs.readFileSync(path.join(workspace, "crlf.txt"))], [...Buffer.from("a\r\nc\r\n")]);

  const preflight = run(
    "*** Begin Patch\n*** Add File: should-not-exist.txt\n+first\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch",
  );
  assert.equal(preflight.status, 1);
  assert.equal(preflight.data.success, false);
  assert.equal(preflight.data.error.code, "PATCH_VERIFICATION_FAILED");
  assert.equal(preflight.data.partialApplied, false);
  assert.equal(fs.existsSync(path.join(workspace, "should-not-exist.txt")), false);

  console.log("apply-patch helper checks passed: 7");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
