import type { CodexAdapter } from "@codehands/codex-adapter";
import type { AgentRegistry } from "./agent-supervisor.js";
import type { ProcessRegistry } from "./process-registry.js";

export interface TestCommandSpec {
  command: string;
  args?: string[];
  cwd?: string;
}

export interface ToolContext {
  adapter: CodexAdapter;
  activeWorkspace: string | null;
  workspaces: string[];
  resolvePath: (relativePath: string) => string;
  processRegistry: ProcessRegistry;
  agentRegistry: AgentRegistry;
  sessionId: string;
  checkBlocked?: (command: string, args?: string[]) => string | null;
  allowShell: boolean;
  testCommands: Record<string, TestCommandSpec>;
  codexBinary: string;
  allowedAgentModels: string[];
}
