/**
 * Relay client for hosted/tunnel access.
 * V2 scope — placeholder for now.
 *
 * Will handle:
 * - Tailscale Funnel integration
 * - Connection status monitoring
 * - Auth middleware for remote connections
 */

export interface RelayConfig {
  type: "tailscale" | "custom";
  enabled: boolean;
}

export function isRelayConfigured(_config: RelayConfig): boolean {
  return false;
}
