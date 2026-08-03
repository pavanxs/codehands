import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const manifest = path.resolve("native/codehands-apply-patch/Cargo.toml");
const executableName = process.platform === "win32" ? "codehands-apply-patch.exe" : "codehands-apply-patch";
const requestedProfile = process.env.CODEHANDS_PATCH_HELPER_PROFILE?.trim() || "release";
if (!/^[A-Za-z0-9_-]+$/.test(requestedProfile)) {
  throw new Error(`Invalid CODEHANDS_PATCH_HELPER_PROFILE: ${requestedProfile}`);
}
const cargoProfileArgs = requestedProfile === "release"
  ? ["--release"]
  : ["--profile", requestedProfile];
const outputProfileDirectory = requestedProfile === "dev" ? "debug" : requestedProfile;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result.stdout ?? "";
}

run("cargo", ["build", ...cargoProfileArgs, "--locked", "--manifest-path", manifest]);
const metadataText = run("cargo", [
  "metadata",
  "--locked",
  "--manifest-path",
  manifest,
  "--format-version",
  "1",
  "--no-deps",
], { capture: true });
const metadata = JSON.parse(metadataText);
const source = path.join(metadata.target_directory, outputProfileDirectory, executableName);
const destinationDirectory = path.resolve("native/codehands-apply-patch/bin");
const destination = path.join(destinationDirectory, executableName);
if (!fs.existsSync(source)) throw new Error(`Cargo reported a successful build but the executable is missing: ${source}`);
fs.mkdirSync(destinationDirectory, { recursive: true });
fs.copyFileSync(source, destination);
if (process.platform !== "win32") fs.chmodSync(destination, 0o755);
console.log(`Patch helper ready (${requestedProfile} profile): ${destination}`);
