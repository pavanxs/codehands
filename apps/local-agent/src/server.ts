import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CodexAdapter } from "@codehands/codex-adapter";
import { TOOL_DEFINITIONS, getHandler, type ToolContext } from "@codehands/mcp-tools";
import { WorkspaceValidator, BlockedCommands, normalizeArgv } from "@codehands/policy-engine";
import { AuditLogger } from "@codehands/audit";
import type { CodehandsConfig } from "./config.js";

export interface SessionState {
  activeWorkspace: string | null;
  ownedProcesses: Set<string>;
}

let globalWorkspace: string | null = null;

export function createServer(config: CodehandsConfig, adapter: CodexAdapter, logger?: AuditLogger) {
  const validator = new WorkspaceValidator(config.workspaces);
  const blockedCmds = new BlockedCommands({ extraPatterns: config.blockedCommands });
  const audit = logger ?? new AuditLogger({ enabled: false });

  if (globalWorkspace === null && config.workspaces.length === 1) {
    globalWorkspace = validator.getWorkspaces()[0] ?? null;
  }

  const sessionState: SessionState = { activeWorkspace: globalWorkspace, ownedProcesses: new Set() };

  const server = new Server(
    { name: "codehands", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_DEFINITIONS.map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: {
          type: "object" as const,
          ...def.inputSchema,
        },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, _extra) => {
    const { name, arguments: params } = request.params;

    const ctx: ToolContext = {
      adapter,
      activeWorkspace: sessionState.activeWorkspace,
      workspaces: validator.getWorkspaces(),
      ownedProcesses: sessionState.ownedProcesses,
      resolvePath: (p: string) => {
        const resolved = validator.resolvePath(p, sessionState.activeWorkspace);
        const check = validator.validate(resolved);
        if (!check.allowed) {
          throw new Error(check.reason);
        }
        return check.resolvedPath;
      },
    };

    if (name === "process_start" && params) {
      const command = params["command"] as string;
      const args = (params["args"] as string[] | undefined) ?? [];
      const argv = normalizeArgv(command, args);
      const blockCheck = blockedCmds.isBlocked(argv);
      if (blockCheck.blocked) {
        return {
          content: [{ type: "text", text: blockCheck.reason! }],
          isError: true,
        } as const;
      }
    }

    const handler = getHandler(name);
    if (!handler) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      } as const;
    }

    const start = Date.now();
    try {
      const result = await handler((params ?? {}) as Record<string, unknown>, ctx);
      if (name === "workspace_set" && !result.isError) {
        sessionState.activeWorkspace = ctx.activeWorkspace;
        globalWorkspace = ctx.activeWorkspace;
      }
      const errorText = result.isError ? result.content[0]?.text : undefined;
      audit.log({
        timestamp: new Date().toISOString(),
        sessionId: "session",
        tool: name,
        params: (params ?? {}) as Record<string, unknown>,
        durationMs: Date.now() - start,
        success: !result.isError,
        error: errorText,
      });
      return {
        content: result.content as Array<{ type: "text"; text: string }>,
        isError: result.isError,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit.log({
        timestamp: new Date().toISOString(),
        sessionId: "session",
        tool: name,
        params: (params ?? {}) as Record<string, unknown>,
        durationMs: Date.now() - start,
        success: false,
        error: message,
      });
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      } as const;
    }
  });

  return { server, validator };
}
