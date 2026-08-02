const ACTIVITY_RESOURCE_PREFIX = "ui://codehands/activity/v2/";
const LEGACY_ACTIVITY_RESOURCE_PREFIX = "ui://codehands/activity/v1/";

const ACTIVITY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tool: { type: "string" },
    label: { type: "string" },
    arguments: { type: "object", additionalProperties: true },
    status: { type: "string", enum: ["succeeded", "failed"] },
    durationMs: { type: "number" },
    startedAt: { type: "string", format: "date-time" },
    completedAt: { type: "string", format: "date-time" },
    error: { type: "string" },
  },
  required: ["tool", "label", "arguments", "status", "durationMs", "startedAt", "completedAt"],
} as const;

const TOOL_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    content: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["text"] },
          text: { type: "string" },
        },
        required: ["type", "text"],
      },
    },
    isError: { type: "boolean" },
  },
  required: ["content", "isError"],
} as const;

export const CODEHANDS_ACTIVITY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    codehandsResult: TOOL_RESULT_SCHEMA,
    codehandsActivity: ACTIVITY_SCHEMA,
    codehandsActivities: { type: "array", items: ACTIVITY_SCHEMA },
  },
  required: ["codehandsResult", "codehandsActivity", "codehandsActivities"],
} as const;

export interface CodeHandsResultContent {
  type: "text";
  text: string;
}

export interface CodeHandsStructuredResult {
  content: CodeHandsResultContent[];
  isError: boolean;
}

export interface CodeHandsActivity {
  tool: string;
  label: string;
  arguments: Record<string, unknown>;
  status: "succeeded" | "failed";
  durationMs: number;
  startedAt: string;
  completedAt: string;
  error?: string;
}

export function isMobileActivityUserAgent(
  navigatorUserAgent: string,
  hostUserAgent?: unknown,
): boolean {
  let hostUserAgentText = "";
  if (typeof hostUserAgent === "string") {
    hostUserAgentText = hostUserAgent;
  } else if (hostUserAgent) {
    try {
      hostUserAgentText = JSON.stringify(hostUserAgent);
    } catch {
      hostUserAgentText = "";
    }
  }
  return /Android|iPhone|iPad|iPod|\bMobile\b/i.test(
    `${navigatorUserAgent} ${hostUserAgentText}`,
  );
}

const TOOL_LABELS: Record<string, { invoking: string; invoked: string }> = {
  fs_readFile: { invoking: "Reading file…", invoked: "Read file" },
  fs_writeFile: { invoking: "Writing file…", invoked: "Wrote file" },
  fs_createDirectory: { invoking: "Creating directory…", invoked: "Created directory" },
  fs_readDirectory: { invoking: "Listing directory…", invoked: "Listed directory" },
  fs_walk: { invoking: "Walking directory tree…", invoked: "Walked directory tree" },
  fs_remove: { invoking: "Removing path…", invoked: "Removed path" },
  fs_copy: { invoking: "Copying path…", invoked: "Copied path" },
  fs_getMetadata: { invoking: "Inspecting metadata…", invoked: "Inspected metadata" },
  process_start: { invoking: "Starting command…", invoked: "Started command" },
  process_read: { invoking: "Reading command output…", invoked: "Read command output" },
  process_write: { invoking: "Sending command input…", invoked: "Sent command input" },
  process_terminate: { invoking: "Stopping process…", invoked: "Stopped process" },
  process_signal: { invoking: "Signalling process…", invoked: "Signalled process" },
  process_list: { invoking: "Listing processes…", invoked: "Listed processes" },
  http_request: { invoking: "Sending HTTP request…", invoked: "Completed HTTP request" },
  workspace_list: { invoking: "Listing workspaces…", invoked: "Listed workspaces" },
  workspace_set: { invoking: "Selecting workspace…", invoked: "Selected workspace" },
  wait: { invoking: "Waiting…", invoked: "Finished waiting" },
  batch: { invoking: "Running tool batch…", invoked: "Completed tool batch" },
};

const SENSITIVE_KEYS = /^(?:content|body|dataBase64|env|token|secret|password|authorization|cookie)$/i;

export function activityResourceUri(tool: string): string {
  return `${ACTIVITY_RESOURCE_PREFIX}${encodeURIComponent(tool)}.html`;
}

export function matchesActivityResourceUri(uri: string, tool: string): boolean {
  const encodedTool = `${encodeURIComponent(tool)}.html`;
  return uri === `${ACTIVITY_RESOURCE_PREFIX}${encodedTool}`
    || uri === `${LEGACY_ACTIVITY_RESOURCE_PREFIX}${encodedTool}`;
}

export function invocationLabels(tool: string): { invoking: string; invoked: string } {
  return TOOL_LABELS[tool] ?? { invoking: "Running CodeHands tool…", invoked: "Completed CodeHands tool" };
}

export function activityTitle(tool: string): string {
  return tool
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function sanitizeActivityArguments(value: unknown, key?: string, depth = 0): unknown {
  if (key && SENSITIVE_KEYS.test(key)) {
    if (typeof value === "string") return `[redacted: ${value.length} chars]`;
    return "[redacted]";
  }

  if (depth >= 4) return "[nested value]";

  if (typeof value === "string") {
    return value.length > 240 ? `${value.slice(0, 237)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    const values = value.slice(0, 12).map((item) => sanitizeActivityArguments(item, undefined, depth + 1));
    if (value.length > 12) values.push(`[${value.length - 12} more items]`);
    return values;
  }
  if (typeof value === "object" && value) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        sanitizeActivityArguments(childValue, childKey, depth + 1),
      ]),
    );
  }
  return String(value);
}

export function createActivity(
  tool: string,
  params: Record<string, unknown>,
  startedAtMs: number,
  durationMs: number,
  success: boolean,
  error?: string,
): CodeHandsActivity {
  return {
    tool,
    label: invocationLabels(tool).invoked,
    arguments: sanitizeActivityArguments(params) as Record<string, unknown>,
    status: success ? "succeeded" : "failed",
    durationMs,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(startedAtMs + durationMs).toISOString(),
    ...(error ? { error } : {}),
  };
}

export function createActivityPayload(
  tool: string,
  params: Record<string, unknown>,
  startedAtMs: number,
  durationMs: number,
  success: boolean,
  content: CodeHandsResultContent[],
  error?: string,
): {
  codehandsResult: CodeHandsStructuredResult;
  codehandsActivity: CodeHandsActivity;
  codehandsActivities: CodeHandsActivity[];
} {
  const activity = createActivity(tool, params, startedAtMs, durationMs, success, error);
  return {
    codehandsResult: { content, isError: !success },
    codehandsActivity: activity,
    // Each ChatGPT tool call gets its own iframe. Including prior calls here made
    // every later iframe replay the full history, so completed chats appeared to
    // keep running while old widgets hydrated. Keep every widget scoped to the
    // one call that created it.
    codehandsActivities: [activity],
  };
}

export function renderActivityWidget(tool: string): string {
  const toolJson = JSON.stringify(tool);
  const labelsJson = JSON.stringify(invocationLabels(tool));
  const allLabelsJson = JSON.stringify(TOOL_LABELS);
  const mobileUserAgentDetector = isMobileActivityUserAgent.toString();

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--color-text-primary, CanvasText); background: transparent; }
    .activity { padding: 5px 2px; font-size: 14px; line-height: 1.35; }
    .summary { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; align-items: center; gap: 8px; }
    .icon { width: 18px; height: 18px; display: grid; place-items: center; font-size: 14px; font-weight: 700; }
    .icon.running { border: 2px solid color-mix(in srgb, currentColor 22%, transparent); border-top-color: currentColor; border-radius: 50%; animation: spin .8s linear infinite; }
    .icon.succeeded { color: #138a4b; }
    .icon.failed { color: #c7352b; }
    .name { min-width: 0; }
    .label { color: var(--color-text-secondary, #707070); margin-right: 6px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .duration { color: var(--color-text-secondary, #707070); font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 12px; }
    details { margin: 5px 0 0 28px; color: var(--color-text-secondary, #707070); }
    summary { cursor: pointer; font-size: 12px; user-select: none; }
    pre { margin: 5px 0 0; padding: 7px 9px; max-height: 180px; overflow: auto; border-radius: 7px; background: color-mix(in srgb, currentColor 6%, transparent); color: var(--color-text-primary, CanvasText); font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
    .error { color: #c7352b; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .icon.running { animation: none; } }
    html[data-codehands-mobile-suppressed="true"],
    html[data-codehands-mobile-suppressed="true"] body {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
      min-height: 0 !important;
      overflow: hidden !important;
    }
  </style>
</head>
<body>
  <section id="current" class="activity" aria-live="polite">
    <div class="summary">
      <span id="icon" class="icon running" aria-label="Running"></span>
      <div class="name"><span id="label" class="label"></span><code id="tool"></code></div>
      <span id="duration" class="duration">0.0s</span>
    </div>
    <details id="details">
      <summary>Call details</summary>
      <pre id="arguments">{}</pre>
      <pre id="error" class="error" hidden></pre>
    </details>
  </section>
  <script>
    const tool = ${toolJson};
    const labels = ${labelsJson};
    const allLabels = ${allLabelsJson};
    const started = performance.now();
    const iconEl = document.getElementById("icon");
    const labelEl = document.getElementById("label");
    const toolEl = document.getElementById("tool");
    const durationEl = document.getElementById("duration");
    const argumentsEl = document.getElementById("arguments");
    const errorEl = document.getElementById("error");
    const pendingRequests = new Map();
    let nextRequestId = 1;
    let connected = false;
    let finished = false;
    let mobileActivitySuppressed = false;
    const isMobileActivityUserAgent = ${mobileUserAgentDetector};

    function isMobileChatGptClient() {
      return isMobileActivityUserAgent(navigator.userAgent || "", window.openai?.userAgent);
    }

    function suppressMobileActivityIfNeeded() {
      if (!isMobileChatGptClient()) return false;
      mobileActivitySuppressed = true;
      document.documentElement.dataset.codehandsMobileSuppressed = "true";
      document.body.setAttribute("aria-hidden", "true");
      window.openai?.notifyIntrinsicHeight?.(0);
      window.parent.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { width: 0, height: 0 },
      }, "*");
      try {
        const closeRequest = window.openai?.requestClose?.();
        if (closeRequest && typeof closeRequest.catch === "function") closeRequest.catch(() => {});
      } catch {
        // Older ChatGPT clients may not expose requestClose; zero-height still
        // removes the activity component from the mobile conversation flow.
      }
      return true;
    }

    window.addEventListener("openai:set_globals", suppressMobileActivityIfNeeded, { passive: true });

    function sanitize(value, key, depth = 0) {
      if (key && /^(?:content|body|dataBase64|env|token|secret|password|authorization|cookie)$/i.test(key)) {
        return typeof value === "string" ? "[redacted: " + value.length + " chars]" : "[redacted]";
      }
      if (depth >= 4) return "[nested value]";
      if (typeof value === "string") return value.length > 240 ? value.slice(0, 237) + "…" : value;
      if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
      if (Array.isArray(value)) return value.slice(0, 12).map((item) => sanitize(item, undefined, depth + 1));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k, depth + 1)]));
      return String(value);
    }

    function showInput(input) {
      if (mobileActivitySuppressed) return;
      argumentsEl.textContent = JSON.stringify(sanitize(input || {}), null, 2);
      notifyHeight();
    }

    function showResult(result) {
      if (mobileActivitySuppressed) return;
      const activity = result?.codehandsActivity;
      if (!activity) return;
      finished = true;
      toolEl.textContent = activity.tool;
      iconEl.className = "icon " + activity.status;
      iconEl.textContent = activity.status === "succeeded" ? "✓" : "×";
      iconEl.setAttribute("aria-label", activity.status === "succeeded" ? "Succeeded" : "Failed");
      labelEl.textContent = activity.label + ".";
      durationEl.textContent = formatDuration(activity.durationMs);
      showInput(activity.arguments);
      if (activity.error) {
        errorEl.hidden = false;
        errorEl.textContent = activity.error;
      }
      notifyHeight();
    }

    function formatDuration(ms) {
      if (ms < 1000) return ms + "ms";
      return (ms / 1000).toFixed(1) + "s";
    }

    function notifyHeight() {
      if (mobileActivitySuppressed) {
        window.openai?.notifyIntrinsicHeight?.(0);
        return;
      }
      requestAnimationFrame(() => {
        const height = document.documentElement.scrollHeight;
        window.openai?.notifyIntrinsicHeight?.(height);
        if (connected) {
          window.parent.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/size-changed",
            params: { width: document.documentElement.scrollWidth, height },
          }, "*");
        }
      });
    }

    function request(method, params) {
      const id = nextRequestId++;
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      return new Promise((resolve, reject) => pendingRequests.set(id, { resolve, reject }));
    }

    if (!suppressMobileActivityIfNeeded()) {
      toolEl.textContent = tool;
      labelEl.textContent = labels.invoking;

      const timer = setInterval(() => {
        if (finished || mobileActivitySuppressed) return clearInterval(timer);
        durationEl.textContent = ((performance.now() - started) / 1000).toFixed(1) + "s";
      }, 100);

      showInput(window.openai?.toolInput || {});
      showResult(window.openai?.toolOutput);

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.id !== undefined && pendingRequests.has(message.id)) {
          const pending = pendingRequests.get(message.id);
          pendingRequests.delete(message.id);
          if (message.error) pending.reject(message.error);
          else pending.resolve(message.result);
          return;
        }
        if (message.method === "ui/notifications/tool-input") showInput(message.params?.arguments ?? message.params);
        if (message.method === "ui/notifications/tool-result") showResult(message.params?.structuredContent);
      }, { passive: true });

      request("ui/initialize", {
        appInfo: { name: "CodeHands Activity", version: "1.0.0" },
        appCapabilities: { availableDisplayModes: ["inline"] },
        protocolVersion: "2026-01-26",
      }).then((result) => {
        const hostTool = result?.hostContext?.toolInfo?.tool?.name;
        if (hostTool) {
          toolEl.textContent = hostTool;
          labelEl.textContent = (allLabels[hostTool] || labels).invoking;
        }
        window.parent.postMessage({
          jsonrpc: "2.0",
          method: "ui/notifications/initialized",
          params: {},
        }, "*");
        connected = true;
        notifyHeight();
      }).catch(() => {
        // ChatGPT compatibility globals above still provide a useful fallback.
        notifyHeight();
      });
    }
  </script>
</body>
</html>`;
}
