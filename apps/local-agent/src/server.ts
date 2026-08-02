import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CodexAdapter } from "@codehands/codex-adapter";
import { TOOL_DEFINITIONS, getHandler, type ToolContext, type ProcessInfo } from "@codehands/mcp-tools";
import { WorkspaceValidator, BlockedCommands, normalizeArgv } from "@codehands/policy-engine";
import { AuditLogger } from "@codehands/audit";
import type { CodehandsConfig } from "./config.js";
import {
  CODEHANDS_ACTIVITY_OUTPUT_SCHEMA,
  activityTitle,
  createActivityPayload,
  invocationLabels,
} from "./activity-ui.js";

export interface SessionState {
  activeWorkspace: string | null;
  ownedProcesses: Map<string, ProcessInfo>;
}

let globalWorkspace: string | null = null;
const globalProcesses: Map<string, ProcessInfo> = new Map();

export interface ServerFeatures {
  batch?: boolean;
}

export function createToolDescriptor(def: (typeof TOOL_DEFINITIONS)[number]) {
  return {
    name: def.name,
    title: activityTitle(def.name),
    description: def.description,
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      ...def.inputSchema,
    },
    outputSchema: CODEHANDS_ACTIVITY_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: def.annotations?.readOnlyHint ?? false,
      destructiveHint: def.annotations?.destructiveHint ?? false,
      openWorldHint: def.name === "http_request" || def.name === "process_start",
    },
    _meta: {
      // Keep native host status labels, but deliberately do not publish a UI
      // resource URI/output template. A widget-side mobile check happens only
      // after the host has instantiated the iframe, which is too late to
      // protect mobile ChatGPT clients that crash while loading that iframe.
      "openai/toolInvocation/invoking": invocationLabels(def.name).invoking,
      "openai/toolInvocation/invoked": invocationLabels(def.name).invoked,
    },
  };
}

export function createServer(config: CodehandsConfig, adapter: CodexAdapter, logger?: AuditLogger, sessionId?: string, features?: ServerFeatures) {
  const validator = new WorkspaceValidator(config.workspaces);
  const blockedCmds = new BlockedCommands({ extraPatterns: config.blockedCommands });
  const audit = logger ?? new AuditLogger({ enabled: false });

  if (globalWorkspace === null && config.workspaces.length === 1) {
    globalWorkspace = validator.getWorkspaces()[0] ?? null;
  }

  const hiddenTools = new Set<string>();
  if (!features?.batch) hiddenTools.add("batch");

  const sessionState: SessionState = { activeWorkspace: globalWorkspace, ownedProcesses: globalProcesses };

  const server = new Server(
    { name: "codehands", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const visibleTools = TOOL_DEFINITIONS.filter((def) => !hiddenTools.has(def.name));
    return {
      tools: visibleTools.map(createToolDescriptor),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, _extra) => {
    const { name, arguments: params } = request.params;

    const ctx: ToolContext = {
      adapter,
      activeWorkspace: sessionState.activeWorkspace,
      workspaces: validator.getWorkspaces(),
      ownedProcesses: sessionState.ownedProcesses,
      sessionId: sessionId ?? "default",
      resolvePath: (p: string) => {
        const resolved = validator.resolvePath(p, sessionState.activeWorkspace);
        const check = validator.validate(resolved);
        if (!check.allowed) {
          throw new Error(check.reason);
        }
        return check.resolvedPath;
      },
      checkBlocked: (command: string, cmdArgs?: string[]) => {
        const argv = normalizeArgv(command, cmdArgs ?? []);
        const result = blockedCmds.isBlocked(argv);
        return result.blocked ? result.reason! : null;
      },
    };

    const start = Date.now();
    const activityPayload = (
      durationMs: number,
      success: boolean,
      content: Array<{ type: "text"; text: string }>,
      error?: string,
    ) =>
      createActivityPayload(
        name,
        (params ?? {}) as Record<string, unknown>,
        start,
        durationMs,
        success,
        content,
        error,
      );

    if (name === "process_start" && params) {
      const command = params["command"] as string;
      const args = (params["args"] as string[] | undefined) ?? [];
      const argv = normalizeArgv(command, args);
      const blockCheck = blockedCmds.isBlocked(argv);
      if (blockCheck.blocked) {
        const durationMs = Date.now() - start;
        const content = [{ type: "text" as const, text: blockCheck.reason! }];
        return {
          content,
          structuredContent: activityPayload(durationMs, false, content, blockCheck.reason!),
          isError: true,
        } as const;
      }
    }

    if (hiddenTools.has(name)) {
      const message = `Tool "${name}" is not enabled. Start with --batch flag to enable it.`;
      const durationMs = Date.now() - start;
      const content = [{ type: "text" as const, text: message }];
      return {
        content,
        structuredContent: activityPayload(durationMs, false, content, message),
        isError: true,
      } as const;
    }

    const handler = getHandler(name);
    if (!handler) {
      const message = `Unknown tool: ${name}`;
      const durationMs = Date.now() - start;
      const content = [{ type: "text" as const, text: message }];
      return {
        content,
        structuredContent: activityPayload(durationMs, false, content, message),
        isError: true,
      } as const;
    }

    try {
      const result = await handler((params ?? {}) as Record<string, unknown>, ctx);
      if (name === "workspace_set" && !result.isError) {
        sessionState.activeWorkspace = ctx.activeWorkspace;
        globalWorkspace = ctx.activeWorkspace;
      }
      const errorText = result.isError ? result.content[0]?.text : undefined;
      const durationMs = Date.now() - start;
      audit.log({
        timestamp: new Date().toISOString(),
        sessionId: sessionId ?? "default",
        tool: name,
        params: (params ?? {}) as Record<string, unknown>,
        durationMs,
        success: !result.isError,
        error: errorText,
      });
      const content = result.content as Array<{ type: "text"; text: string }>;
      return {
        content,
        structuredContent: activityPayload(durationMs, !result.isError, content, errorText),
        isError: result.isError,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - start;
      audit.log({
        timestamp: new Date().toISOString(),
        sessionId: sessionId ?? "default",
        tool: name,
        params: (params ?? {}) as Record<string, unknown>,
        durationMs,
        success: false,
        error: message,
      });
      const content = [{ type: "text" as const, text: `Error: ${message}` }];
      return {
        content,
        structuredContent: activityPayload(durationMs, false, content, message),
        isError: true,
      } as const;
    }
  });

  return { server, validator };
}
