import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codexRoot = resolve(root, "vendor", "codex", "codex-rs");

const check = spawnSync(process.execPath, [resolve(root, "scripts", "check-codex.mjs")], {
  cwd: root,
  stdio: "inherit",
});
if (check.status !== 0) process.exit(check.status ?? 1);

const build = spawnSync("cargo", ["build", "--locked", "--release", "-p", "codex-cli", "--bin", "codex"], {
  cwd: codexRoot,
  stdio: "inherit",
});
if (build.error?.code === "ENOENT") {
  console.error("Rust/Cargo is required to build the pinned exec-server. Install it from https://rustup.rs/");
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

const executable = process.platform === "win32" ? "codex.exe" : "codex";
const binary = resolve(codexRoot, "target", "release", executable);
console.log(`Pinned Codex binary built at:\n${binary}`);
console.log("Set config.codexBinary to this absolute path.");
