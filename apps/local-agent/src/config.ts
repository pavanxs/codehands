import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface CodehandsConfig {
  workspaces: string[];
  port: number;
  blockedCommands?: string[];
  codexBinary?: string;
}

const DEFAULT_CONFIG: CodehandsConfig = {
  workspaces: [],
  port: 3100,
};

function getConfigPath(): string {
  return path.join(os.homedir(), ".codehands", "config.json");
}

function getConfigDir(): string {
  return path.join(os.homedir(), ".codehands");
}

export function loadConfig(): CodehandsConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<CodehandsConfig>;

  return {
    workspaces: parsed.workspaces ?? [],
    port: parsed.port ?? 3100,
    blockedCommands: parsed.blockedCommands,
    codexBinary: parsed.codexBinary,
  };
}

export function initConfig(): string {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  if (fs.existsSync(configPath)) {
    return configPath;
  }

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const defaultContent: CodehandsConfig = {
    workspaces: [],
    port: 3100,
    blockedCommands: [],
  };

  fs.writeFileSync(configPath, JSON.stringify(defaultContent, null, 2) + "\n", "utf-8");
  return configPath;
}

export { getConfigPath };
