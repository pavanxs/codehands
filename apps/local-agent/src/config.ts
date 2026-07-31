import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import type { HttpPolicyOptions } from "@codehands/policy-engine";

export interface CodehandsConfig {
  workspaces: string[];
  port: number;
  host: string;
  auth: {
    enabled: boolean;
    tokenEnv: string;
  };
  authToken?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  maxRequestBytes: number;
  rateLimitPerMinute: number;
  sessionTtlMs: number;
  blockedCommands?: string[];
  allowedExecutables?: string[];
  allowedEnvironmentVariables?: string[];
  allowShell?: boolean;
  http?: HttpPolicyOptions;
  codexBinary?: string;
}

const DEFAULT_CONFIG: CodehandsConfig = {
  workspaces: [],
  port: 3100,
  host: "127.0.0.1",
  auth: {
    enabled: true,
    tokenEnv: "CODEHANDS_AUTH_TOKEN",
  },
  allowedHosts: ["localhost", "127.0.0.1", "::1"],
  allowedOrigins: [],
  maxRequestBytes: 1_048_576,
  rateLimitPerMinute: 120,
  sessionTtlMs: 1_800_000,
};

function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

function getConfigDir(): string {
  const override = process.env["CODEHANDS_CONFIG_DIR"];
  if (!override) return path.join(os.homedir(), ".codehands");
  if (!path.isAbsolute(override)) {
    throw new Error("CODEHANDS_CONFIG_DIR must be an absolute path");
  }
  return path.resolve(override);
}

function getTokenPath(): string {
  return path.join(getConfigDir(), "http-token");
}

export function loadConfig(): CodehandsConfig {
  const configPath = getConfigPath();

  const parsed = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf-8")) as Partial<CodehandsConfig>
    : {};
  const auth = {
    ...DEFAULT_CONFIG.auth,
    ...(parsed.auth ?? {}),
  };
  const authToken = process.env[auth.tokenEnv] ?? readTokenFile();

  return {
    workspaces: parsed.workspaces ?? [],
    port: parsed.port ?? 3100,
    host: parsed.host ?? DEFAULT_CONFIG.host,
    auth,
    authToken,
    allowedHosts: parsed.allowedHosts ?? DEFAULT_CONFIG.allowedHosts,
    allowedOrigins: parsed.allowedOrigins ?? DEFAULT_CONFIG.allowedOrigins,
    maxRequestBytes: parsed.maxRequestBytes ?? DEFAULT_CONFIG.maxRequestBytes,
    rateLimitPerMinute: parsed.rateLimitPerMinute ?? DEFAULT_CONFIG.rateLimitPerMinute,
    sessionTtlMs: parsed.sessionTtlMs ?? DEFAULT_CONFIG.sessionTtlMs,
    blockedCommands: parsed.blockedCommands,
    allowedExecutables: parsed.allowedExecutables,
    allowedEnvironmentVariables: parsed.allowedEnvironmentVariables,
    allowShell: parsed.allowShell ?? false,
    http: parsed.http,
    codexBinary: parsed.codexBinary,
  };
}

export function initConfig(): string {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  if (fs.existsSync(configPath)) {
    fs.chmodSync(configPath, 0o600);
    ensureTokenFile();
    return configPath;
  }

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(configDir, 0o700);

  const defaultContent: CodehandsConfig = {
    ...DEFAULT_CONFIG,
    blockedCommands: [],
    allowedExecutables: [],
    allowedEnvironmentVariables: [],
    allowShell: false,
    http: {
      enabled: false,
      allowedHosts: [],
      allowedMethods: ["GET", "HEAD"],
      allowHttp: false,
      allowPrivateNetwork: false,
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(defaultContent, null, 2) + "\n", "utf-8");
  fs.chmodSync(configPath, 0o600);
  ensureTokenFile();
  return configPath;
}

function ensureTokenFile(): string {
  const tokenPath = getTokenPath();
  if (!fs.existsSync(getConfigDir())) fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(getConfigDir(), 0o700);
  if (!fs.existsSync(tokenPath)) {
    fs.writeFileSync(tokenPath, randomBytes(32).toString("base64url") + "\n", { mode: 0o600 });
  }
  fs.chmodSync(tokenPath, 0o600);
  return tokenPath;
}

function readTokenFile(): string | undefined {
  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) return undefined;
  const token = fs.readFileSync(tokenPath, "utf-8").trim();
  return token || undefined;
}

export { getConfigPath, getTokenPath, ensureTokenFile };
