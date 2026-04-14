import { maskEmailAddress, normalizeEmailAddress, hashSensitiveValue } from "./authTelemetry.js";

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const store = new Map();

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nowMs() {
  return Date.now();
}

function cleanupExpiredEntries(currentNow = nowMs()) {
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt <= currentNow) {
      store.delete(key);
    }
  }
}

function makeBucketKey({ action, scope, key }) {
  return `${action}:${scope}:${key}`;
}

function consumeBucket({ action, scope, key, limit, windowMs }, currentNow = nowMs()) {
  const bucketKey = makeBucketKey({ action, scope, key });
  const entry = store.get(bucketKey);

  if (!entry || entry.resetAt <= currentNow) {
    const nextEntry = {
      count: 1,
      resetAt: currentNow + windowMs,
      limit,
      windowMs,
    };
    store.set(bucketKey, nextEntry);
    return {
      allowed: true,
      remaining: Math.max(limit - 1, 0),
      retryAfterSeconds: Math.ceil(windowMs / 1000),
    };
  }

  entry.count += 1;
  if (entry.count > limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(Math.ceil((entry.resetAt - currentNow) / 1000), 1),
    };
  }

  return {
    allowed: true,
    remaining: Math.max(limit - entry.count, 0),
    retryAfterSeconds: Math.max(Math.ceil((entry.resetAt - currentNow) / 1000), 1),
  };
}

const RATE_LIMIT_RULES = {
  sign_up: [
    { scope: "ip", limit: 5, windowMs: 10 * 60 * 1000 },
    { scope: "email", limit: 3, windowMs: 30 * 60 * 1000 },
  ],
  sign_in: [
    { scope: "ip", limit: 10, windowMs: 10 * 60 * 1000 },
    { scope: "email", limit: 6, windowMs: 10 * 60 * 1000 },
    { scope: "ip_email", limit: 5, windowMs: 10 * 60 * 1000 },
  ],
  resend_verification: [
    { scope: "ip", limit: 5, windowMs: 10 * 60 * 1000 },
    { scope: "email", limit: 3, windowMs: 30 * 60 * 1000 },
  ],
  forgot_password: [
    { scope: "ip", limit: 5, windowMs: 10 * 60 * 1000 },
    { scope: "email", limit: 3, windowMs: 30 * 60 * 1000 },
  ],
  reset_password: [
    { scope: "ip", limit: 5, windowMs: 15 * 60 * 1000 },
    { scope: "token", limit: 3, windowMs: 30 * 60 * 1000 },
  ],
  change_password: [
    { scope: "ip", limit: 10, windowMs: 15 * 60 * 1000 },
    { scope: "session", limit: 5, windowMs: 15 * 60 * 1000 },
  ],
};

function resolveRuleOverride(action, rule, property) {
  const key = `AUTH_RATE_LIMIT_${action.toUpperCase()}_${rule.scope.toUpperCase()}_${property}`;
  if (property === "WINDOW_MS") {
    return parsePositiveInt(process.env[key], rule.windowMs);
  }
  return parsePositiveInt(process.env[key], rule.limit);
}

function getRulesForAction(action) {
  const baseRules = RATE_LIMIT_RULES[action] || [];
  return baseRules.map((rule) => ({
    ...rule,
    limit: resolveRuleOverride(action, rule, "LIMIT"),
    windowMs: resolveRuleOverride(action, rule, "WINDOW_MS"),
  }));
}

function sanitizeKeyForScope(scope, context = {}) {
  if (scope === "ip") return context.ipAddress || "";
  if (scope === "email") return normalizeEmailAddress(context.email);
  if (scope === "ip_email") return `${context.ipAddress || ""}:${normalizeEmailAddress(context.email)}`;
  if (scope === "session") return context.sessionKey || "";
  if (scope === "token") return context.tokenKey || "";
  return "";
}

function describeScope(scope, context = {}) {
  if (scope === "ip") return { ip: context.ipMasked || "" };
  if (scope === "email") return { email: maskEmailAddress(context.email) };
  if (scope === "ip_email") return { ip: context.ipMasked || "", email: maskEmailAddress(context.email) };
  if (scope === "session") return { sessionKey: context.sessionKey ? hashSensitiveValue(context.sessionKey) : "" };
  if (scope === "token") return { tokenKey: context.tokenKey ? hashSensitiveValue(context.tokenKey) : "" };
  return {};
}

export function getAuthRateLimitConfigSnapshot() {
  const snapshot = {};
  for (const action of Object.keys(RATE_LIMIT_RULES)) {
    snapshot[action] = getRulesForAction(action);
  }
  return {
    storeMode: "memory",
    rules: snapshot,
  };
}

export function resetAuthRateLimitStore() {
  store.clear();
}

export function consumeAuthRateLimit(action, context = {}) {
  cleanupExpiredEntries();

  const rules = getRulesForAction(action);
  if (!rules.length) {
    return { allowed: true };
  }

  let blockedRule = null;
  let retryAfterSeconds = 0;

  for (const rule of rules) {
    const key = sanitizeKeyForScope(rule.scope, context);
    if (!key) {
      continue;
    }

    const result = consumeBucket({
      action,
      scope: rule.scope,
      key,
      limit: rule.limit,
      windowMs: rule.windowMs || DEFAULT_WINDOW_MS,
    });

    if (!result.allowed) {
      blockedRule = {
        scope: rule.scope,
        limit: rule.limit,
        windowMs: rule.windowMs || DEFAULT_WINDOW_MS,
        ...describeScope(rule.scope, context),
      };
      retryAfterSeconds = Math.max(retryAfterSeconds, result.retryAfterSeconds);
      break;
    }
  }

  if (!blockedRule) {
    return { allowed: true };
  }

  return {
    allowed: false,
    retryAfterSeconds,
    rule: blockedRule,
  };
}
