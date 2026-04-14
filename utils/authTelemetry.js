import crypto from "crypto";

import { captureSentryException } from "./sentry.js";

const AUTH_EVENT_LOG_LIMIT = 50;

const authTelemetryState = {
  counters: {},
  recentEvents: [],
};

export function maskEmailAddress(address = "") {
  const [localPart = "", domain = ""] = String(address).trim().toLowerCase().split("@");
  if (!domain) return "";
  if (localPart.length <= 2) {
    return `${localPart[0] || "*"}***@${domain}`;
  }
  return `${localPart.slice(0, 2)}***@${domain}`;
}

export function normalizeEmailAddress(address = "") {
  return String(address).trim().toLowerCase();
}

export function hashSensitiveValue(value = "") {
  if (!value) return "";
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

export function maskIpAddress(ipAddress = "") {
  const value = String(ipAddress || "").trim();
  if (!value) return "";
  return `ip_${hashSensitiveValue(value)}`;
}

export function getClientIpAddress(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : String(forwardedFor || "").split(",")[0];
  const rawIp = firstForwarded || req.ip || req.socket?.remoteAddress || "";
  return String(rawIp).trim();
}

function pushRecentAuthEvent(event) {
  authTelemetryState.recentEvents.unshift(event);
  if (authTelemetryState.recentEvents.length > AUTH_EVENT_LOG_LIMIT) {
    authTelemetryState.recentEvents.length = AUTH_EVENT_LOG_LIMIT;
  }
}

export function recordAuthEvent(event, details = {}) {
  const key = String(event || "unknown");
  authTelemetryState.counters[key] = (authTelemetryState.counters[key] || 0) + 1;

  const entry = {
    event: key,
    at: new Date().toISOString(),
    ...details,
  };

  pushRecentAuthEvent(entry);
  console.info("[auth-event]", entry);
  return entry;
}

export function recordAuthFailure(event, error, context = {}) {
  const normalizedMessage = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : context.message || "Auth operation failed";

  recordAuthEvent(event, {
    outcome: "failure",
    ...context,
    error: normalizedMessage,
  });

  captureSentryException(error, {
    tags: {
      feature: "auth",
      event,
      ...(context.tags || {}),
    },
    extra: {
      authContext: context,
    },
  });
}

export function getAuthTelemetrySnapshot() {
  return {
    counters: { ...authTelemetryState.counters },
    recentEvents: [...authTelemetryState.recentEvents],
  };
}
