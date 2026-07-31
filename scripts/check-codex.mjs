import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const submodule = resolve(root, "vendor", "codex");

function git(args, cwd = root) {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

const expected = git(["ls-tree", "HEAD", "vendor/codex"]).split(/\s+/)[2];
if (!expected) throw new Error("vendor/codex is not recorded as a Git submodule");
const actual = git(["rev-parse", "HEAD"], submodule);
const dirty = git(["status", "--porcelain"], submodule);

if (actual !== expected) {
  throw new Error(`Codex submodule mismatch: expected ${expected}, found ${actual}. Run git submodule update --init vendor/codex.`);
}
if (dirty) throw new Error("vendor/codex has local changes; CodeHands never modifies upstream Codex");

console.log(`Codex submodule verified at ${actual}`);
