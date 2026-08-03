# MCP Tool Contracts

The authoritative current tool contracts, result envelopes, continuation rules, output schemas, and remaining contract decisions are maintained in [`CURRENT_PLAN.md`](./CURRENT_PLAN.md).

This file intentionally does not duplicate those contracts. Update `CURRENT_PLAN.md` whenever a tool decision changes.

Runtime definitions remain in `packages/mcp-tools/src/definitions.ts` and runtime handlers remain in `packages/mcp-tools/src/handlers.ts`. The source currently defines 24 tools; per-session capability negotiation hides `request_user_input` from clients without MCP form elicitation. The active server process and installed client snapshot must be restarted/refreshed before they expose newly built definitions.
