const LOCAL_FRONTEND_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

const DEPLOYED_FRONTEND_ORIGINS = [
  "https://my-ai-assistant-ypzx.vercel.app",
  "https://my-ai-assistant-taupe.vercel.app",
  "https://my-ai-assistant-git-stage-mohammed-abushayiqahs-projects.vercel.app",
  "https://my-ai-assistant-git-production-mohammed-abushayiqahs-projects.vercel.app",
  "https://my-ai-assistant.vercel.app",
  "https://studymaxing.com",
  "https://www.studymaxing.com",
];

const PRODUCTION_FRONTEND_ORIGINS = [
  "https://studymaxing.com",
  "https://www.studymaxing.com",
];

const STAGING_FRONTEND_ORIGINS = [
  "https://stage.studymaxing.com",
];

const REMOVED_FRONTEND_ORIGINS = new Set([
  "https://my-ai-assistant-git-stage-msaa07.vercel.app",
]);

function normalizeOrigin(origin = "") {
  const value = origin.trim();
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseOriginList(raw = "") {
  return raw
    .split(",")
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
}

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function getConfiguredBackendUrl(env = process.env) {
  return env.BETTER_AUTH_URL || env.BETTER_AUTH_BASE_URL || "";
}

function getDeploymentIdentity(env = process.env) {
  const labels = [
    env.RAILWAY_ENVIRONMENT,
    env.BACKEND_DEPLOYMENT_ENV,
    env.NODE_ENV,
  ]
    .filter(hasValue)
    .map((value) => value.trim().toLowerCase());

  if (labels.some((value) => value === "stage" || value === "staging" || value.includes("staging"))) {
    return "staging";
  }

  if (labels.some((value) => value === "prod" || value === "production" || value.includes("production"))) {
    return "production";
  }

  const backendUrl = getConfiguredBackendUrl(env);
  if (hasValue(backendUrl)) {
    try {
      const url = new URL(backendUrl);
      if (url.protocol === "https:") {
        if (url.hostname.includes("staging") || url.hostname.startsWith("stage.")) {
          return "staging";
        }
        if (url.hostname.includes("production")) {
          return "production";
        }
        return "deployed";
      }
    } catch {
      // Invalid deployment URLs do not make local development a trusted deployment.
    }
  }

  if (
    hasValue(env.RAILWAY_PUBLIC_DOMAIN)
    || hasValue(env.RAILWAY_STATIC_URL)
    || hasValue(env.RAILWAY_SERVICE_ID)
    || hasValue(env.RAILWAY_PROJECT_ID)
  ) {
    return "deployed";
  }

  return "local";
}

export function getFrontendDeploymentMode(env = process.env) {
  return getDeploymentIdentity(env);
}

export function isAllowedVercelPreviewOrigin(origin = "") {
  if (getFrontendDeploymentMode() !== "local") {
    return false;
  }

  const normalizedOrigin = normalizeOrigin(origin);
  if (REMOVED_FRONTEND_ORIGINS.has(normalizedOrigin)) {
    return false;
  }

  return normalizedOrigin.endsWith(".vercel.app")
    && normalizedOrigin.includes("my-ai-assistant");
}

export function getAllowedFrontendOrigins() {
  const deploymentMode = getFrontendDeploymentMode();
  const defaultOrigins = deploymentMode === "production"
    ? PRODUCTION_FRONTEND_ORIGINS
    : deploymentMode === "staging"
      ? STAGING_FRONTEND_ORIGINS
      : deploymentMode === "local"
        ? [...LOCAL_FRONTEND_ORIGINS, ...DEPLOYED_FRONTEND_ORIGINS]
        : [];

  return [
    ...defaultOrigins,
    ...parseOriginList(process.env.FRONTEND_ORIGINS || ""),
  ].filter((origin) => !REMOVED_FRONTEND_ORIGINS.has(origin));
}

export function isAllowedFrontendOrigin(origin = "") {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return false;

  return getAllowedFrontendOrigins().includes(normalizedOrigin)
    || isAllowedVercelPreviewOrigin(normalizedOrigin);
}

export function createCorsOriginValidator({ allowNoOrigin = true } = {}) {
  return (origin, callback) => {
    if (!origin) {
      return callback(null, allowNoOrigin);
    }

    if (isAllowedFrontendOrigin(origin)) {
      return callback(null, true);
    }

    return callback(null, false);
  };
}
