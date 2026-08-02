import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CodexAdapter } from "@codehands/codex-adapter";
import {
  AgentRegistry,
  ProcessRegistry,
  TOOL_DEFINITIONS,
  getHandler,
  type ToolContext,
} from "@codehands/mcp-tools";
import { WorkspaceValidator, BlockedCommands, normalizeArgv } from "@codehands/policy-engine";
import { AuditLogger } from "@codehands/audit";
import type { CodehandsConfig } from "./config.js";
import {
  CODEHANDS_ACTIVITY_OUTPUT_SCHEMA,
  activityResourceUri,
  activityTitle,
  createActivityPayload,
  invocationLabels,
  renderActivityWidget,
} from "./activity-ui.js";

export interface SessionState {
  activeWorkspace: string | null;
}

let globalWorkspace: string | null = null;
const globalProcesses = new ProcessRegistry();
const globalAgents = new AgentRegistry();

export interface ServerFeatures {
  batch?: boolean;
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
  if (!config.allowShell) hiddenTools.add("process_startShell");

  const sessionState: SessionState = { activeWorkspace: globalWorkspace };

  const server = new Server(
    { name: "codehands", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const visibleTools = TOOL_DEFINITIONS.filter((def) => !hiddenTools.has(def.name));
    return {
      tools: visibleTools.map((def) => ({
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
          openWorldHint: def.name === "http_request" || def.name.startsWith("process_") || def.name.startsWith("agent_"),
        },
        _meta: {
          ui: { resourceUri: activityResourceUri(def.name) },
          "openai/outputTemplate": activityResourceUri(def.name),
          "openai/toolInvocation/invoking": invocationLabels(def.name).invoking,
          "openai/toolInvocation/invoked": invocationLabels(def.name).invoked,
        },
      })),
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const visibleTools = TOOL_DEFINITIONS.filter((def) => !hiddenTools.has(def.name));
    return {
      resources: visibleTools.map((def) => ({
        uri: activityResourceUri(def.name),
        name: `${activityTitle(def.name)} activity`,
        description: `Inline progress and result details for the ${def.name} CodeHands tool.`,
        mimeType: "text/html;profile=mcp-app",
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const visibleTools = TOOL_DEFINITIONS.filter((def) => !hiddenTools.has(def.name));
    const definition = visibleTools.find((def) => activityResourceUri(def.name) === request.params.uri);
    if (!definition) throw new Error(`Unknown activity resource: ${request.params.uri}`);

    return {
      contents: [{
        uri: activityResourceUri(definition.name),
        mimeType: "text/html;profile=mcp-app",
        text: renderActivityWidget(definition.name),
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { connectDomains: [], resourceDomains: [] },
          },
          "openai/widgetPrefersBorder": false,
          "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
        },
      }],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, _extra) => {
    const { name, arguments: params } = request.params;

    const ctx: ToolContext = {
      adapter,
      activeWorkspace: sessionState.activeWorkspace,
      workspaces: validator.getWorkspaces(),
      processRegistry: globalProcesses,
      agentRegistry: globalAgents,
      sessionId: sessionId ?? "default",
      allowShell: config.allowShell ?? false,
      testCommands: config.testCommands ?? {},
      codexBinary: config.codexBinary ?? "codex",
      allowedAgentModels: config.agentModels ?? [],
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
      const message = name === "process_startShell"
        ? `Tool "${name}" is disabled. Set allowShell: true in CodeHands config to opt in.`
        : `Tool "${name}" is not enabled. Start with --batch flag to enable it.`;
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
