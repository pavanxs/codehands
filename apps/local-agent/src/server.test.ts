import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "@codehands/mcp-tools";
import { createToolDescriptor } from "./server.js";

describe("CodeHands tool descriptors", () => {
  it("never advertises widget resources to ChatGPT clients", () => {
    for (const definition of TOOL_DEFINITIONS) {
      const descriptor = createToolDescriptor(definition);
      const metadata = descriptor._meta as Record<string, unknown>;

      expect(metadata.ui).toBeUndefined();
      expect(metadata["openai/outputTemplate"]).toBeUndefined();
      expect(metadata["openai/toolInvocation/invoking"]).toBeTruthy();
      expect(metadata["openai/toolInvocation/invoked"]).toBeTruthy();
    }
  });
});
