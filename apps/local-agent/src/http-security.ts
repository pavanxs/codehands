import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CodehandsConfig } from "./config.js";

export class FixedWindowRateLimiter {
  private readonly counters = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const current = this.counters.get(key);
    if (!current || current.resetAt <= now) {
      this.counters.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }

  sweep(now = Date.now()): void {
    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= now) this.counters.delete(key);
    }
  }
}

export function authorizeHttpRequest(
  req: IncomingMessage,
  config: CodehandsConfig,
  limiter: FixedWindowRateLimiter,
): { allowed: true } | { allowed: false; status: number; message: string } {
  const remoteAddress = req.socket.remoteAddress ?? "unknown";
  if (!limiter.allow(remoteAddress)) {
    return { allowed: false, status: 429, message: "Too many requests" };
  }

  const hostHeader = req.headers.host;
  if (!hostHeader || !isAllowedHost(hostHeader, config.allowedHosts)) {
    return { allowed: false, status: 403, message: "Host is not allowed" };
  }

  const origin = req.headers.origin;
  if (origin && !config.allowedOrigins.includes(origin)) {
    return { allowed: false, status: 403, message: "Origin is not allowed" };
  }

  if (config.auth.enabled) {
    const authorization = req.headers.authorization;
    if (!config.authToken || !authorization?.startsWith("Bearer ")) {
      return { allowed: false, status: 401, message: "Bearer authentication required" };
    }
    if (!safeEqual(authorization.slice("Bearer ".length), config.authToken)) {
      return { allowed: false, status: 401, message: "Invalid bearer token" };
    }
  }

  return { allowed: true };
}

export function sendHttpError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...(status === 401 ? { "WWW-Authenticate": 'Bearer realm="codehands"' } : {}),
  });
  res.end(JSON.stringify({ error: message }));
}

function isAllowedHost(hostHeader: string, allowedHosts: string[]): boolean {
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return allowedHosts.some((allowed) => allowed.replace(/^\[|\]$/g, "").toLowerCase() === hostname);
  } catch {
    return false;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
