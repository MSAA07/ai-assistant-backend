const LOCAL_FRONTEND_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

const PRODUCTION_FRONTEND_ORIGINS = [
  "https://my-ai-assistant-git-production-mohammed-abushayiqahs-projects.vercel.app",
  "https://my-ai-assistant.vercel.app",
  "https://studymaxing.com",
  "https://www.studymaxing.com",
];

const PREVIEW_FRONTEND_ORIGINS = [
  "https://my-ai-assistant-ypzx.vercel.app",
  "https://my-ai-assistant-taupe.vercel.app",
  "https://my-ai-assistant-git-stage-mohammed-abushayiqahs-projects.vercel.app",
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

export function isAllowedVercelPreviewOrigin(origin = "") {
  if (process.env.NODE_ENV === "production") {
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
  const environmentOrigins = parseOriginList(process.env.FRONTEND_ORIGINS || "");
  const developmentOrigins = process.env.NODE_ENV === "development"
    ? [
        ...LOCAL_FRONTEND_ORIGINS,
        ...PREVIEW_FRONTEND_ORIGINS,
      ]
    : [];

  return [
    ...PRODUCTION_FRONTEND_ORIGINS,
    ...environmentOrigins,
    ...developmentOrigins,
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
