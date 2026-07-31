import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CodexAdapter } from "@codehands/codex-adapter";
import { TOOL_DEFINITIONS, getHandler, type ToolContext } from "@codehands/mcp-tools";
import {
  WorkspaceValidator,
  BlockedCommands,
  CommandPolicy,
  HttpPolicy,
  normalizeArgv,
} from "@codehands/policy-engine";
import { AuditLogger } from "@codehands/audit";
import type { CodehandsConfig } from "./config.js";

export interface SessionState {
  activeWorkspace: string | null;
  ownedProcesses: Set<string>;
}

export function createServer(
  config: CodehandsConfig,
  adapter: CodexAdapter,
  logger?: AuditLogger,
  sessionId = "local",
) {
  const validator = new WorkspaceValidator(config.workspaces);
  const blockedCmds = new BlockedCommands({ extraPatterns: config.blockedCommands });
  const commandPolicy = new CommandPolicy({
    allowedExecutables: config.allowedExecutables,
    allowedEnvironmentVariables: config.allowedEnvironmentVariables,
    allowShell: config.allowShell,
  });
  const httpPolicy = new HttpPolicy(config.http);
  const audit = logger ?? new AuditLogger({ enabled: false });

  const sessionState: SessionState = {
    activeWorkspace: config.workspaces.length === 1 ? validator.getWorkspaces()[0] ?? null : null,
    ownedProcesses: new Set(),
  };

  const server = new Server(
    { name: "codehands", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const onRestarting = (attempt: number, max: number) => {
    void server.sendLoggingMessage({
      level: "warning",
      logger: "codehands",
      data: `exec-server restarted (${attempt}/${max}); existing process handles are no longer valid`,
    }).catch(() => undefined);
    sessionState.ownedProcesses.clear();
  };
  const onFailed = (err: Error) => {
    void server.sendLoggingMessage({
      level: "error",
      logger: "codehands",
      data: `exec-server failed permanently: ${err.message}`,
    }).catch(() => undefined);
    sessionState.ownedProcesses.clear();
  };
  adapter.on("restarting", onRestarting);
  adapter.on("failed", onFailed);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_DEFINITIONS.map((def) => ({
        name: def.name,
        description: def.description,
        annotations: def.annotations,
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
      commandPolicy,
      httpPolicy,
      ownedProcesses: sessionState.ownedProcesses,
      recentActivity: (limit: number) => audit.recent(sessionId, limit),
      resolvePath: (p: string) => {
        const resolved = validator.resolvePath(p, sessionState.activeWorkspace);
        const check = validator.validateInWorkspace(resolved, sessionState.activeWorkspace);
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
        audit.log({
          timestamp: new Date().toISOString(),
          sessionId,
          tool: name,
          params: (params ?? {}) as Record<string, unknown>,
          durationMs: 0,
          success: false,
          error: blockCheck.reason,
          resultSummary: "Blocked by command policy",
        });
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
      }
      const errorText = result.isError ? result.content[0]?.text : undefined;
      audit.log({
        timestamp: new Date().toISOString(),
        sessionId,
        tool: name,
        params: (params ?? {}) as Record<string, unknown>,
        durationMs: Date.now() - start,
        success: !result.isError,
        error: errorText,
        resultSummary: summarizeResult(result.content[0]?.text),
      });
      return {
        content: result.content as Array<{ type: "text"; text: string }>,
        isError: result.isError,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit.log({
        timestamp: new Date().toISOString(),
        sessionId,
        tool: name,
        params: (params ?? {}) as Record<string, unknown>,
        durationMs: Date.now() - start,
        success: false,
        error: message,
        resultSummary: "Tool call threw an exception",
      });
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      } as const;
    }
  });

  server.onclose = async () => {
    adapter.off("restarting", onRestarting);
    adapter.off("failed", onFailed);
    for (const processId of sessionState.ownedProcesses) {
      await adapter.processTerminate({ processId }).catch(() => undefined);
    }
    sessionState.ownedProcesses.clear();
  };

  return { server };
}

function summarizeResult(text: string | undefined): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>);
      const fields = entries.map(([key, value]) => {
        if (Array.isArray(value)) return `${key}[${value.length}]`;
        if (typeof value === "string") return `${key}(${value.length} chars)`;
        return key;
      });
      return `Returned fields: ${fields.join(", ")}`;
    }
    if (Array.isArray(parsed)) return `Returned array with ${parsed.length} items`;
  } catch {
    // Non-JSON tool results are summarized by size so output is never copied
    // into the audit log.
  }
  return `Returned ${text.length} characters`;
}
