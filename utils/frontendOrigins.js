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
  return origin.endsWith(".vercel.app") && origin.includes("my-ai-assistant");
}

export function getAllowedFrontendOrigins() {
  return [
    ...LOCAL_FRONTEND_ORIGINS,
    ...DEPLOYED_FRONTEND_ORIGINS,
    ...parseOriginList(process.env.FRONTEND_ORIGINS || ""),
  ];
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

    return callback(new Error("Not allowed by CORS"));
  };
}
