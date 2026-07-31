import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getCapabilityTokenPath,
  getConfigPath,
  getTokenPath,
  initConfig,
  rotateCapabilityTokenFile,
} from "./config.js";

const originalConfigDir = process.env["CODEHANDS_CONFIG_DIR"];
const temporaryRoots: string[] = [];

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env["CODEHANDS_CONFIG_DIR"];
  } else {
    process.env["CODEHANDS_CONFIG_DIR"] = originalConfigDir;
  }
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("isolated configuration directory", () => {
  it("moves configuration and token under an absolute override", () => {
    const override = path.resolve("/tmp", "codehands-isolated-config");
    process.env["CODEHANDS_CONFIG_DIR"] = override;
    expect(getConfigPath()).toBe(path.join(override, "config.json"));
    expect(getTokenPath()).toBe(path.join(override, "http-token"));
    expect(getCapabilityTokenPath()).toBe(path.join(override, "capability-token"));
  });

  it("rejects a relative override", () => {
    process.env["CODEHANDS_CONFIG_DIR"] = "relative-config";
    expect(() => getConfigPath()).toThrow("must be an absolute path");
  });

  it("creates private configuration and restores a missing token", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codehands-config-test-"));
    temporaryRoots.push(root);
    process.env["CODEHANDS_CONFIG_DIR"] = path.join(root, "state");

    const configPath = initConfig();
    const tokenPath = getTokenPath();
    const capabilityTokenPath = getCapabilityTokenPath();
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(tokenPath)).toBe(true);
    expect(fs.existsSync(capabilityTokenPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(capabilityTokenPath).mode & 0o777).toBe(0o600);
    }

    fs.rmSync(tokenPath);
    expect(initConfig()).toBe(configPath);
    expect(fs.existsSync(tokenPath)).toBe(true);
    fs.rmSync(capabilityTokenPath);
    expect(initConfig()).toBe(configPath);
    expect(fs.existsSync(capabilityTokenPath)).toBe(true);
  });

  it("rotates the capability token without changing the bearer token", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codehands-config-test-"));
    temporaryRoots.push(root);
    process.env["CODEHANDS_CONFIG_DIR"] = path.join(root, "state");
    initConfig();

    const bearerBefore = fs.readFileSync(getTokenPath(), "utf-8");
    const capabilityBefore = fs.readFileSync(getCapabilityTokenPath(), "utf-8");
    rotateCapabilityTokenFile();

    expect(fs.readFileSync(getTokenPath(), "utf-8")).toBe(bearerBefore);
    expect(fs.readFileSync(getCapabilityTokenPath(), "utf-8")).not.toBe(capabilityBefore);
  });
});
