export interface CodehandsConfig {
  workspaces: string[];
  port: number;
  blockedCommands?: string[];
  codexBinary?: string;
  audit?: {
    enabled?: boolean;
    logDir?: string;
    redactContent?: boolean;
  };
}

export interface ToolCallRequest {
  sessionId: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export const CODEHANDS_VERSION = "0.1.0";
export const DEFAULT_PORT = 3100;
export const CONFIG_DIR_NAME = ".codehands";
export const CONFIG_FILE_NAME = "config.json";
