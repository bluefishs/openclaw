/**
 * Correlation ID middleware for cross-service request tracing.
 *
 * Propagates incoming X-Correlation-Id header or generates a new UUID v4.
 * Sets the correlation ID on the response header for downstream consumers
 * (NemoClaw, CK_ plugins, Grafana/Loki log correlation).
 *
 * Usage:
 *   const correlationId = ensureCorrelationId(req, res);
 *   // correlationId is now available for logging & response meta
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getHeader } from "./http-utils.js";

export const CORRELATION_HEADER = "x-correlation-id";

/** Safe pattern: UUID v4 or alphanumeric + dashes/underscores, max 128 chars */
const VALID_CORRELATION_RE = /^[a-zA-Z0-9_\-.:]{1,128}$/;

/**
 * Extract existing correlation ID from request or generate a new one.
 * Always sets the response header so downstream services can propagate it.
 */
export function ensureCorrelationId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = getHeader(req, CORRELATION_HEADER);

  // Use incoming value if it passes validation; otherwise generate fresh
  const correlationId = incoming && VALID_CORRELATION_RE.test(incoming) ? incoming : randomUUID();

  // Stamp onto request headers so downstream handlers can read it
  req.headers[CORRELATION_HEADER] = correlationId;

  // Set response header for callers (NemoClaw, federation clients)
  res.setHeader("X-Correlation-Id", correlationId);

  return correlationId;
}

/**
 * Read the correlation ID that was previously set by ensureCorrelationId.
 * Returns undefined if not yet initialized.
 */
export function getCorrelationId(req: IncomingMessage): string | undefined {
  return getHeader(req, CORRELATION_HEADER);
}
