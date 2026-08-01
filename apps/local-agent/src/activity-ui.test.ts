import { describe, expect, it } from "vitest";
import {
  CODEHANDS_ACTIVITY_OUTPUT_SCHEMA,
  activityResourceUri,
  createActivity,
  createActivityPayload,
  invocationLabels,
  isMobileActivityUserAgent,
  renderActivityWidget,
  sanitizeActivityArguments,
} from "./activity-ui.js";

describe("CodeHands activity UI", () => {
  it("creates a stable resource URI for each tool", () => {
    expect(activityResourceUri("fs_readFile")).toBe("ui://codehands/activity/v1/fs_readFile.html");
  });

  it("publishes the structured activity result schema", () => {
    expect(CODEHANDS_ACTIVITY_OUTPUT_SCHEMA.required).toContain("codehandsActivity");
    expect(CODEHANDS_ACTIVITY_OUTPUT_SCHEMA.required).toContain("codehandsActivities");
    expect(CODEHANDS_ACTIVITY_OUTPUT_SCHEMA.required).toContain("codehandsResult");
  });

  it("redacts sensitive values while keeping useful call arguments", () => {
    expect(sanitizeActivityArguments({
      path: "README.md",
      content: "secret text",
      env: { API_TOKEN: "abc" },
      nested: { body: "private" },
    })).toEqual({
      path: "README.md",
      content: "[redacted: 11 chars]",
      env: "[redacted]",
      nested: { body: "[redacted: 7 chars]" },
    });
  });

  it("creates a compact success or failure payload", () => {
    const activity = createActivity("fs_getMetadata", { path: "package.json" }, 1_000, 12, true);
    expect(activity).toMatchObject({
      tool: "fs_getMetadata",
      arguments: { path: "package.json" },
      durationMs: 12,
      status: "succeeded",
    });
  });

  it("includes recent calls in the inline activity ledger", () => {
    createActivityPayload("workspace_list", {}, 100_000, 1, true, [
      { type: "text", text: '{"workspaces":["/workspace"]}' },
    ]);
    const payload = createActivityPayload("fs_getMetadata", { path: "package.json" }, 100_010, 2, true, [
      { type: "text", text: '{"path":"package.json","size":123}' },
    ]);
    expect(payload.codehandsActivities.map((activity) => activity.tool)).toEqual([
      "workspace_list",
      "fs_getMetadata",
    ]);
  });

  it("keeps the actual tool output in the model-visible structured result", () => {
    const content = [{
      type: "text" as const,
      text: '{"workspaces":["/Users/georgegood/Desktop/Auto Shorts Web App"]}',
    }];
    const payload = createActivityPayload("workspace_list", {}, 200_000, 3, true, content);

    expect(payload.codehandsResult).toEqual({ content, isError: false });
    expect(payload.codehandsResult.content[0]?.text).toContain("Auto Shorts Web App");
  });

  it("keeps ChatGPT invocation labels within the documented limit", () => {
    const labels = invocationLabels("http_request");
    expect(labels.invoking.length).toBeLessThanOrEqual(64);
    expect(labels.invoked.length).toBeLessThanOrEqual(64);
  });

  it("renders a self-contained MCP Apps component", () => {
    const html = renderActivityWidget("workspace_list");
    expect(html).toContain("ui/notifications/tool-input");
    expect(html).toContain("ui/notifications/tool-result");
    expect(html).toContain('request("ui/initialize"');
    expect(html).toContain('method: "ui/notifications/initialized"');
    expect(html).toContain("codehandsActivities");
    expect(html).toContain("workspace_list");
    expect(html).not.toContain("<script src=");
  });

  it("suppresses and closes the inline activity component on mobile ChatGPT clients", () => {
    const html = renderActivityWidget("workspace_list");

    expect(html).toContain("isMobileChatGptClient");
    expect(html).toContain("Android|iPhone|iPad|iPod");
    expect(html).toContain("openai:set_globals");
    expect(html).toContain("requestClose");
    expect(html).toContain("notifyIntrinsicHeight?.(0)");
    expect(html).toContain('params: { width: 0, height: 0 }');
    expect(html).toContain('data-codehands-mobile-suppressed="true"');
  });

  it("detects Android and iOS without treating a narrow desktop iframe as mobile", () => {
    expect(isMobileActivityUserAgent(
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile Safari/537.36",
    )).toBe(true);
    expect(isMobileActivityUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15",
    )).toBe(true);
    expect(isMobileActivityUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126",
    )).toBe(false);
    expect(isMobileActivityUserAgent("desktop-shell", { device: { type: "mobile" } })).toBe(true);
  });
});
