import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const manifest = path.resolve("native/codehands-apply-patch/Cargo.toml");
const executableName = process.platform === "win32" ? "codehands-apply-patch.exe" : "codehands-apply-patch";
const metadataResult = spawnSync("cargo", [
  "metadata",
  "--locked",
  "--manifest-path",
  manifest,
  "--format-version",
  "1",
  "--no-deps",
], { encoding: "utf8", windowsHide: true });
if (metadataResult.error) throw metadataResult.error;
if (metadataResult.status !== 0) throw new Error(metadataResult.stderr || "cargo metadata failed");
const metadata = JSON.parse(metadataResult.stdout);
const source = path.join(metadata.target_directory, "release", executableName);
const destinationDirectory = path.resolve("native/codehands-apply-patch/bin");
const destination = path.join(destinationDirectory, executableName);
if (!fs.existsSync(source)) throw new Error(`Built helper is missing: ${source}`);
fs.mkdirSync(destinationDirectory, { recursive: true });
fs.copyFileSync(source, destination);
if (process.platform !== "win32") fs.chmodSync(destination, 0o755);
console.log(`Patch helper copied to: ${destination}`);
