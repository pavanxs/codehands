import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface CodehandsConfig {
  workspaces: string[];
  port: number;
  blockedCommands?: string[];
  codexBinary?: string;
  allowShell?: boolean;
  testCommands?: Record<string, { command: string; args?: string[]; cwd?: string }>;
  agentModels?: string[];
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
    allowShell: parsed.allowShell ?? false,
    testCommands: parsed.testCommands,
    agentModels: parsed.agentModels,
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
    allowShell: false,
    testCommands: {},
    agentModels: [],
  };

  fs.writeFileSync(configPath, JSON.stringify(defaultContent, null, 2) + "\n", "utf-8");
  return configPath;
}

export function addWorkspace(workspacePath: string): { added: boolean; resolved: string; reason?: string } {
  const resolved = path.resolve(workspacePath);

  if (!fs.existsSync(resolved)) {
    return { added: false, resolved, reason: `Path does not exist: ${resolved}` };
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return { added: false, resolved, reason: `Not a directory: ${resolved}` };
  }

  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    initConfig();
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as { workspaces: string[]; [key: string]: unknown };

  const normalize = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const alreadyExists = config.workspaces.some((w) => normalize(w) === normalize(resolved));
  if (alreadyExists) {
    return { added: false, resolved, reason: `Already in config: ${resolved}` };
  }

  config.workspaces.push(resolved);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return { added: true, resolved };
}

export { getConfigPath };
