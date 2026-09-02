const DEFAULT_TTL_MS = 90_000;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 120_000;
const DEFAULT_LIMIT = 100;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function parseTtl(value) {
  const parsed = Number.parseInt(value, 10);
  return clamp(Number.isFinite(parsed) ? parsed : DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS);
}

function normalizeIssue(issue) {
  const timestamp = issue.lastSeen || issue.firstSeen || new Date().toISOString();
  const level = String(issue.level || "error").toLowerCase();
  const severity = ["fatal", "error"].includes(level) ? "critical" : level === "warning" ? "warning" : "info";

  return {
    id: String(issue.id),
    shortId: issue.shortId || null,
    title: issue.title || issue.metadata?.value || "Untitled Sentry issue",
    message: issue.culprit || issue.metadata?.filename || issue.metadata?.type || "Captured by Sentry",
    severity,
    status: issue.status || "unresolved",
    createdAt: new Date(timestamp),
    permalink: issue.permalink || null,
    metadata: {
      count: Number(issue.count) || 0,
      firstSeen: issue.firstSeen || null,
      lastSeen: issue.lastSeen || null,
      project: issue.project?.slug || null,
      level,
    },
  };
}

export function getSentryIssuesConfig(env = process.env) {
  return {
    token: env.SENTRY_ISSUES_AUTH_TOKEN?.trim() || "",
    organization: env.SENTRY_ORG?.trim() || env.SENTRY_ORGANIZATION?.trim() || "",
    project: env.SENTRY_PROJECT?.trim() || env.SENTRY_PROJECT_SLUG?.trim() || "",
    environment: env.SENTRY_ENVIRONMENT?.trim() || "staging",
    baseUrl: (env.SENTRY_ISSUES_BASE_URL?.trim() || "https://sentry.io/api/0").replace(/\/+$/, ""),
    ttlMs: parseTtl(env.SENTRY_ISSUES_CACHE_TTL_MS),
  };
}

export function createSentryIssuesClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const config = getSentryIssuesConfig(env);
  let cache = null;
  let inFlight = null;

  async function refresh() {
    if (!config.token || !config.organization || !config.project || !fetchImpl) {
      return {
        items: cache?.items || [],
        status: cache ? "stale" : "unavailable",
        fetchedAt: cache?.fetchedAt || null,
        error: "Sentry issues integration is not configured",
      };
    }

    const url = new URL(
      `${config.baseUrl}/projects/${encodeURIComponent(config.organization)}/${encodeURIComponent(config.project)}/issues/`,
    );
    url.searchParams.set("environment", config.environment);
    url.searchParams.set("sort", "date");
    url.searchParams.set("limit", String(DEFAULT_LIMIT));

    try {
      const response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        throw new Error(`Sentry issues request failed with ${response.status}`);
      }

      const payload = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error("Sentry issues response was not an array");
      }

      cache = {
        items: payload.map(normalizeIssue),
        fetchedAt: new Date(now()),
      };
      return { ...cache, status: "fresh", error: null };
    } catch (error) {
      if (cache) {
        return {
          ...cache,
          status: "stale",
          error: error?.message || "Sentry issues refresh failed",
        };
      }
      return {
        items: [],
        status: "unavailable",
        fetchedAt: null,
        error: error?.message || "Sentry issues refresh failed",
      };
    }
  }

  async function getIssues({ force = false } = {}) {
    if (!force && cache && now() - cache.fetchedAt.getTime() < config.ttlMs) {
      return { ...cache, status: "fresh", error: null };
    }
    if (!inFlight) {
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return {
    getIssues,
    getConfig() {
      return {
        configured: Boolean(config.token && config.organization && config.project),
        organization: config.organization,
        project: config.project,
        environment: config.environment,
        ttlMs: config.ttlMs,
      };
    },
  };
}

export const sentryIssuesClient = createSentryIssuesClient();
