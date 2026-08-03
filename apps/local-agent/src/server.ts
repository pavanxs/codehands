import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CodexAdapter } from "@codehands/codex-adapter";
import { TOOL_DEFINITIONS, getHandler, type ToolContext, type ProcessInfo } from "@codehands/mcp-tools";
import { WorkspaceValidator, BlockedCommands } from "@codehands/policy-engine";
import { AuditLogger } from "@codehands/audit";
import type { CodehandsConfig } from "./config.js";

let globalWorkspace: string | null = null;
const globalProcesses: Map<string, ProcessInfo> = new Map();

export interface ServerFeatures {
  batch?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeResultItems(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!isRecord(value) || !Array.isArray(value.results)) return undefined;
  return value.results.map((item, index) => {
    if (!isRecord(item)) return { index, success: false };
    const summary: Record<string, unknown> = {
      index: typeof item.index === "number" ? item.index : index,
      success: item.success !== false,
    };
    for (const key of ["tool", "status", "durationMs", "timedOut", "exitCode", "processId", "exited", "closed"] as const) {
      const field = item[key];
      if (field !== undefined) summary[key] = field;
    }
    if (isRecord(item.data)) {
      const children = summarizeResultItems(item.data);
      if (children) summary.children = children;
    }
    return summary;
  });
}

function buildAuditOutcome(tool: string, structuredContent: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!structuredContent || !["batch", "process_run", "process_read"].includes(tool)) return undefined;
  const results = summarizeResultItems(structuredContent);
  return results ? { results } : undefined;
}

export function createServer(
  config: CodehandsConfig,
  adapter: CodexAdapter,
  logger?: AuditLogger,
  sessionId?: string,
  features?: ServerFeatures,
) {
  const validator = new WorkspaceValidator(config.workspaces);
  const blockedCmds = new BlockedCommands({ extraPatterns: config.blockedCommands });
  const audit = logger ?? new AuditLogger({ enabled: false });

  const approvedWorkspaces = validator.getWorkspaces();
  const normalizeWorkspace = (value: string) => value.replace(/\\/g, "/").toLowerCase();
  const activeWorkspaceIsApproved = globalWorkspace !== null
    && approvedWorkspaces.some((workspace) => normalizeWorkspace(workspace) === normalizeWorkspace(globalWorkspace!));
  if (!activeWorkspaceIsApproved) {
    globalWorkspace = approvedWorkspaces[0] ?? null;
  }

  const hiddenTools = new Set<string>();
  if (!features?.batch) hiddenTools.add("batch");

  const server = new Server(
    { name: "codehands", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const supportsFormElicitation = (): boolean => {
    const elicitation = server.getClientCapabilities()?.elicitation;
    if (!elicitation) return false;
    if (Object.keys(elicitation).length === 0) return true;
    return "form" in elicitation && elicitation.form !== undefined;
  };

  const isToolHidden = (name: string): boolean =>
    hiddenTools.has(name) || (name === "request_user_input" && !supportsFormElicitation());

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const visibleTools = TOOL_DEFINITIONS.filter((definition) => !isToolHidden(definition.name));
    return {
      tools: visibleTools.map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: {
          type: "object" as const,
          additionalProperties: false,
          ...definition.inputSchema,
        },
        outputSchema: definition.outputSchema,
        annotations: definition.annotations,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: params } = request.params;
    const ctx: ToolContext = {
      adapter,
      activeWorkspace: globalWorkspace,
      workspaces: validator.getWorkspaces(),
      ownedProcesses: globalProcesses,
      sessionId: sessionId ?? "default",
      resolvePath: (requestedPath: string) => {
        const resolved = validator.resolvePath(requestedPath, globalWorkspace);
        const check = validator.validate(resolved);
        if (!check.allowed) throw new Error(check.reason);
        return check.resolvedPath;
      },
      checkBlocked: (argv: string[]) => {
        const result = blockedCmds.isBlocked(argv);
        return result.blocked ? result.reason! : null;
      },
      requestUserInput: async (prompt) => {
        if (!supportsFormElicitation()) {
          throw new Error("The connected MCP client does not support form elicitation.");
        }
        const valueSchema: {
          type: "string";
          title: string;
          description?: string;
          minLength: number;
          maxLength: number;
          default?: string;
        } = {
          type: "string",
          title: prompt.label,
          ...(prompt.placeholder === undefined ? {} : { description: prompt.placeholder }),
          minLength: prompt.minLength,
          maxLength: prompt.maxLength,
          ...(prompt.defaultValue === undefined ? {} : { default: prompt.defaultValue }),
        };
        const response = await server.elicitInput({
          mode: "form",
          message: prompt.message,
          requestedSchema: {
            type: "object",
            properties: { value: valueSchema },
            ...(prompt.required ? { required: ["value"] } : {}),
          },
        });
        const value = response.action === "accept" && typeof response.content?.["value"] === "string"
          ? response.content["value"]
          : undefined;
        return {
          action: response.action,
          ...(value === undefined ? {} : { value }),
        };
      },
    };

    if (isToolHidden(name)) {
      const reason = name === "request_user_input"
        ? "The connected MCP client does not support form elicitation."
        : `Tool "${name}" is not enabled. Start with --batch flag to enable it.`;
      return {
        content: [{ type: "text" as const, text: reason }],
        isError: true,
      };
    }

    const handler = getHandler(name);
    if (!handler) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const start = Date.now();
    const startedAt = new Date(start).toISOString();
    try {
      const result = await handler((params ?? {}) as Record<string, unknown>, ctx);
      if (name === "workspace_set" && !result.isError) {
        globalWorkspace = ctx.activeWorkspace;
      }
      const auditParams = name === "request_user_input" && typeof result.structuredContent?.["action"] === "string"
        ? { ...((params ?? {}) as Record<string, unknown>), resultAction: result.structuredContent["action"] }
        : (params ?? {}) as Record<string, unknown>;
      audit.log({
        timestamp: new Date().toISOString(),
        startedAt,
        sessionId: sessionId ?? "default",
        tool: name,
        params: auditParams,
        durationMs: Date.now() - start,
        success: !result.isError,
        error: result.isError ? result.content.find((item) => item.type === "text")?.text : undefined,
        outcome: buildAuditOutcome(name, result.structuredContent),
      });
      return {
        content: result.content,
        structuredContent: result.structuredContent,
        isError: result.isError,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      audit.log({
        timestamp: new Date().toISOString(),
        startedAt,
        sessionId: sessionId ?? "default",
        tool: name,
        params: (params ?? {}) as Record<string, unknown>,
        durationMs: Date.now() - start,
        success: false,
        error: message,
      });
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return { server, validator };
}
