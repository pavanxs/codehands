import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { CodexAdapter, EnvironmentInfo } from "@codehands/codex-adapter";

export type ProcessLaunchMode = "direct" | "shell";

export interface ResolveProcessLaunchOptions {
  adapter: CodexAdapter;
  command: string;
  args?: string[];
  shell?: boolean;
  cwd: string;
  env?: Record<string, string>;
  platform?: NodeJS.Platform;
}

export interface ResolvedProcessLaunch {
  mode: ProcessLaunchMode;
  argv: string[];
  policyArgv: string[];
  env: Record<string, string>;
  displayCommand: string;
  resolvedCommand?: string;
  shellInfo?: EnvironmentInfo["shell"];
}

const WINDOWS_DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];
const executableResolutionCache = new WeakMap<CodexAdapter, Map<string, Promise<string | null>>>();

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const match = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return match ? env[match] : undefined;
}

function uniquePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function windowsBatchWrapperBase64(target: string, args: string[]): string {
  const invocation = [quotePowerShellLiteral(target), ...args.map(quotePowerShellLiteral)].join(" ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `& ${invocation}`,
    "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }",
  ].join("; ");
  return Buffer.from(script, "utf16le").toString("base64");
}

async function isExecutableFile(adapter: CodexAdapter, candidate: string): Promise<boolean> {
  try {
    const metadata = await adapter.fsGetMetadata({ path: pathToFileURL(candidate).href });
    return metadata.isFile;
  } catch {
    return false;
  }
}

async function resolveWindowsExecutable(
  adapter: CodexAdapter,
  command: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const pathValue = envValue(env, "PATH") ?? "";
  const pathExtValue = envValue(env, "PATHEXT") ?? WINDOWS_DEFAULT_PATHEXT.join(";");
  const cacheKey = `${command}\u0000${cwd}\u0000${pathValue}\u0000${pathExtValue}`;
  let adapterCache = executableResolutionCache.get(adapter);
  if (!adapterCache) {
    adapterCache = new Map();
    executableResolutionCache.set(adapter, adapterCache);
  }
  const cached = adapterCache.get(cacheKey);
  if (cached) return cached;

  const resolution = (async () => {
    const hasPath = path.win32.isAbsolute(command) || /[\\/]/.test(command);
    const extension = path.win32.extname(command);
    const pathExts = pathExtValue
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.startsWith(".") ? entry : `.${entry}`);
    const suffixes = extension ? [""] : pathExts.length > 0 ? pathExts : WINDOWS_DEFAULT_PATHEXT;

    const bases = hasPath
      ? [path.win32.isAbsolute(command) ? command : path.win32.resolve(cwd, command)]
      : [
          cwd,
          ...pathValue
            .split(";")
            .map((entry) => entry.trim().replace(/^"|"$/g, ""))
            .filter(Boolean),
        ].map((directory) => path.win32.join(directory, command));

    const candidates = uniquePaths(bases.flatMap((base) => suffixes.map((suffix) => `${base}${suffix}`)));
    for (const candidate of candidates) {
      if (await isExecutableFile(adapter, candidate)) return candidate;
    }
    return null;
  })();

  adapterCache.set(cacheKey, resolution);
  return resolution;
}

function shellArgv(shell: EnvironmentInfo["shell"], command: string): string[] {
  switch (shell.name) {
    case "zsh":
    case "bash":
    case "sh":
      return [shell.path, "-c", command];
    case "powershell":
      return [shell.path, "-NoProfile", "-Command", command];
    case "cmd":
      return [shell.path, "/c", command];
    default:
      throw new Error(`Unsupported environment shell: ${shell.name}`);
  }
}

async function resolvePowerShell(
  adapter: CodexAdapter,
  environmentInfo: EnvironmentInfo,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  if (environmentInfo.shell.name === "powershell") return environmentInfo.shell.path;

  const systemRoot = envValue(env, "SystemRoot");
  if (systemRoot) {
    const builtIn = path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (await isExecutableFile(adapter, builtIn)) return builtIn;
  }

  return await resolveWindowsExecutable(adapter, "pwsh.exe", cwd, env)
    ?? await resolveWindowsExecutable(adapter, "powershell.exe", cwd, env);
}

export async function resolveProcessLaunch(
  options: ResolveProcessLaunchOptions,
): Promise<ResolvedProcessLaunch> {
  const command = options.command.trim();
  if (!command) throw new Error("Command must not be empty.");

  const argsProvided = options.args !== undefined;
  const args = options.args ?? [];
  const useShell = options.shell ?? !argsProvided;
  if (useShell && args.length > 0) {
    throw new Error("args cannot be used when shell is true; include shell syntax in command instead.");
  }

  const platform = options.platform ?? process.platform;
  const customEnv = { ...(options.env ?? {}) };
  const resolutionEnv: Record<string, string | undefined> = { ...process.env, ...customEnv };

  if (useShell) {
    const environmentInfo = await options.adapter.getEnvironmentInfo();
    const argv = shellArgv(environmentInfo.shell, command);
    return {
      mode: "shell",
      argv,
      policyArgv: argv,
      env: customEnv,
      displayCommand: command,
      shellInfo: environmentInfo.shell,
    };
  }

  if (platform !== "win32") {
    const argv = [command, ...args];
    return {
      mode: "direct",
      argv,
      policyArgv: argv,
      env: customEnv,
      displayCommand: [command, ...args].join(" "),
      resolvedCommand: command,
    };
  }

  const resolvedCommand = await resolveWindowsExecutable(
    options.adapter,
    command,
    options.cwd,
    resolutionEnv,
  );
  if (!resolvedCommand) {
    throw new Error(`Executable not found on PATH: ${command}`);
  }

  const extension = path.win32.extname(resolvedCommand).toLowerCase();
  const policyArgv = [resolvedCommand, ...args];
  if (extension === ".cmd" || extension === ".bat") {
    const environmentInfo = await options.adapter.getEnvironmentInfo();
    const powershell = await resolvePowerShell(
      options.adapter,
      environmentInfo,
      options.cwd,
      resolutionEnv,
    );
    if (!powershell) {
      throw new Error(
        `Cannot safely execute Windows batch command without PowerShell: ${resolvedCommand}`,
      );
    }

    return {
      mode: "direct",
      argv: [
        powershell,
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        windowsBatchWrapperBase64(resolvedCommand, args),
      ],
      policyArgv,
      env: customEnv,
      displayCommand: policyArgv.join(" "),
      resolvedCommand,
    };
  }

  if (extension !== ".exe" && extension !== ".com") {
    throw new Error(
      `Windows direct execution supports .exe, .com, .cmd, and .bat files; use shell: true for ${resolvedCommand}`,
    );
  }

  return {
    mode: "direct",
    argv: policyArgv,
    policyArgv,
    env: customEnv,
    displayCommand: policyArgv.join(" "),
    resolvedCommand,
  };
}
