import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { authorizeHttpRequest, FixedWindowRateLimiter, isCapabilityPath } from "./http-security.js";
import type { CodehandsConfig } from "./config.js";

const CONFIG: CodehandsConfig = {
  workspaces: [],
  port: 3100,
  host: "127.0.0.1",
  auth: { enabled: true, tokenEnv: "CODEHANDS_AUTH_TOKEN" },
  authToken: "correct-token",
  capabilityPath: { enabled: true, tokenEnv: "CODEHANDS_CAPABILITY_TOKEN" },
  capabilityToken: "1234567890123456789012345678901234567890123",
  allowedHosts: ["localhost"],
  allowedOrigins: ["https://chatgpt.com"],
  maxRequestBytes: 1024,
  rateLimitPerMinute: 2,
  sessionTtlMs: 1000,
};

function request(headers: Record<string, string> = {}) {
  const req = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    socket: { remoteAddress: string };
  };
  req.headers = { host: "localhost:3100", ...headers };
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}

describe("HTTP MCP security", () => {
  it("requires a valid bearer token", () => {
    const limiter = new FixedWindowRateLimiter(10);
    expect(authorizeHttpRequest(request() as never, CONFIG, limiter).allowed).toBe(false);
    expect(authorizeHttpRequest(request({ authorization: "Bearer wrong" }) as never, CONFIG, limiter).allowed).toBe(false);
    expect(authorizeHttpRequest(request({ authorization: "Bearer correct-token" }) as never, CONFIG, limiter).allowed).toBe(true);
  });

  it("matches only the exact configured capability path", () => {
    expect(isCapabilityPath(`/${CONFIG.capabilityToken}/mcp`, CONFIG)).toBe(true);
    expect(isCapabilityPath(`/${CONFIG.capabilityToken}/mcp/`, CONFIG)).toBe(false);
    expect(isCapabilityPath("/wrong/mcp", CONFIG)).toBe(false);
    expect(isCapabilityPath("/mcp", CONFIG)).toBe(false);
    expect(isCapabilityPath("/short/mcp", {
      ...CONFIG,
      capabilityToken: "short",
    })).toBe(false);
  });

  it("uses the capability path instead of bearer auth without bypassing host and origin checks", () => {
    const limiter = new FixedWindowRateLimiter(10);
    expect(authorizeHttpRequest(request() as never, CONFIG, limiter, "capability").allowed).toBe(true);
    expect(authorizeHttpRequest(request({ host: "evil.example" }) as never, CONFIG, limiter, "capability").allowed).toBe(false);
    expect(authorizeHttpRequest(
      request({ origin: "https://evil.example" }) as never,
      CONFIG,
      limiter,
      "capability",
    ).allowed).toBe(false);
  });

  it("rejects unapproved hosts and origins", () => {
    const limiter = new FixedWindowRateLimiter(10);
    expect(authorizeHttpRequest(request({
      host: "evil.example",
      authorization: "Bearer correct-token",
    }) as never, CONFIG, limiter).allowed).toBe(false);
    expect(authorizeHttpRequest(request({
      origin: "https://evil.example",
      authorization: "Bearer correct-token",
    }) as never, CONFIG, limiter).allowed).toBe(false);
  });

  it("enforces a fixed-window request limit", () => {
    const limiter = new FixedWindowRateLimiter(1);
    const req = request({ authorization: "Bearer correct-token" }) as never;
    expect(authorizeHttpRequest(req, CONFIG, limiter).allowed).toBe(true);
    const second = authorizeHttpRequest(req, CONFIG, limiter);
    expect(second.allowed).toBe(false);
    if (!second.allowed) expect(second.status).toBe(429);
  });
});
