import {
  getFrontendDeploymentMode,
  isAllowedFrontendOrigin,
} from "./frontendOrigins.js";

const authCallbackDiagnostics = {
  lastAction: "",
  lastUpdatedAt: "",
  lastCallbackSource: "",
  lastCallbackUrl: "",
  lastCallbackHost: "",
  lastRawAuthUrl: "",
  lastResolvedActionUrl: "",
};

const PRODUCTION_AUTH_APP_URL = "https://studymaxing.com";
const STAGING_AUTH_APP_URL = "https://stage.studymaxing.com";

function normalizeAbsoluteUrl(value = "") {
  const trimmed = String(value).trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    url.hash = "";
    if (url.pathname.endsWith("/") && url.pathname !== "/") {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function redactToken(value = "") {
  const normalized = normalizeAbsoluteUrl(value);
  if (!normalized) return "";

  try {
    const url = new URL(normalized);
    if (url.searchParams.has("token")) {
      url.searchParams.set("token", "[redacted]");
    }
    return url.toString();
  } catch {
    return normalized;
  }
}

function extractCallbackUrl(url = "") {
  try {
    const parsedUrl = new URL(url);
    const callbackUrl = parsedUrl.searchParams.get("callbackURL");
    return callbackUrl ? normalizeAbsoluteUrl(decodeURIComponent(callbackUrl)) : "";
  } catch {
    return "";
  }
}

function buildFrontendActionUrl(baseUrl, params) {
  const normalizedBaseUrl = normalizeAbsoluteUrl(baseUrl);
  if (!normalizedBaseUrl) return "";

  const url = new URL(normalizedBaseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });

  return url.toString();
}

function getFirstConfiguredUrl(envNames = []) {
  for (const envName of envNames) {
    const value = normalizeAbsoluteUrl(process.env[envName] || "");
    if (value) {
      const sanitized = sanitizeCallbackUrl(value);
      if (sanitized) {
        return sanitized;
      }
    }
  }

  return "";
}

function sanitizeCallbackUrl(value = "") {
  const normalized = normalizeAbsoluteUrl(value);
  if (!normalized) return "";
  if (getFrontendDeploymentMode() === "local") return normalized;

  try {
    return isAllowedFrontendOrigin(new URL(normalized).origin) ? normalized : "";
  } catch {
    return "";
  }
}

function resolveFrontendCallbackBase({ rawUrl, action, envNames }) {
  const extractedCallbackUrl = extractCallbackUrl(rawUrl);
  if (extractedCallbackUrl) {
    const sanitizedCallbackUrl = sanitizeCallbackUrl(extractedCallbackUrl);
    if (sanitizedCallbackUrl) {
      return {
        source: "request",
        callbackUrl: sanitizedCallbackUrl,
      };
    }
  }

  const configuredCallbackUrl = getFirstConfiguredUrl(envNames);
  if (configuredCallbackUrl) {
    return {
      source: "env",
      callbackUrl: configuredCallbackUrl,
    };
  }

  const appUrl = getFirstConfiguredUrl(["AUTH_EMAIL_APP_URL"]);
  if (appUrl) {
    return {
      source: "app_url",
      callbackUrl: buildFrontendActionUrl(appUrl, { auth_action: action }),
    };
  }

  const deploymentMode = getFrontendDeploymentMode();
  if (deploymentMode === "production") {
    return {
      source: "production_default",
      callbackUrl: buildFrontendActionUrl(PRODUCTION_AUTH_APP_URL, { auth_action: action }),
    };
  }

  if (deploymentMode === "staging") {
    return {
      source: "staging_default",
      callbackUrl: buildFrontendActionUrl(STAGING_AUTH_APP_URL, { auth_action: action }),
    };
  }

  if (deploymentMode === "deployed") {
    throw new Error("A trusted auth callback URL is required for this HTTPS deployment");
  }

  return {
    source: "raw_better_auth_url",
    callbackUrl: "",
  };
}

function rememberCallbackDiagnostics({ action, source, rawUrl, callbackUrl, resolvedActionUrl }) {
  authCallbackDiagnostics.lastAction = action;
  authCallbackDiagnostics.lastUpdatedAt = new Date().toISOString();
  authCallbackDiagnostics.lastCallbackSource = source;
  authCallbackDiagnostics.lastCallbackUrl = redactToken(callbackUrl);
  authCallbackDiagnostics.lastCallbackHost = callbackUrl
    ? (() => {
      try {
        return new URL(callbackUrl).host;
      } catch {
        return "";
      }
    })()
    : "";
  authCallbackDiagnostics.lastRawAuthUrl = redactToken(rawUrl);
  authCallbackDiagnostics.lastResolvedActionUrl = redactToken(resolvedActionUrl);

  console.info("[auth-callback] resolved action URL", {
    action,
    callbackSource: source,
    callbackHost: authCallbackDiagnostics.lastCallbackHost || "(missing)",
    callbackUrl: authCallbackDiagnostics.lastCallbackUrl || "(missing)",
    rawAuthUrl: authCallbackDiagnostics.lastRawAuthUrl || "(missing)",
    resolvedActionUrl: authCallbackDiagnostics.lastResolvedActionUrl || "(missing)",
  });
}

function buildActionUrl({ action, rawUrl, token, envNames }) {
  const { source, callbackUrl } = resolveFrontendCallbackBase({
    rawUrl,
    action,
    envNames,
  });

  const resolvedActionUrl = callbackUrl && token
    ? buildFrontendActionUrl(callbackUrl, {
      auth_action: action,
      token,
    })
    : rawUrl;

  rememberCallbackDiagnostics({
    action,
    source,
    rawUrl,
    callbackUrl,
    resolvedActionUrl,
  });

  return resolvedActionUrl;
}

export function getAuthCallbackDiagnostics() {
  return { ...authCallbackDiagnostics };
}

export function buildVerificationEmailActionUrl({ url, token }) {
  return buildActionUrl({
    action: "verify-email",
    rawUrl: url,
    token,
    envNames: [
      "AUTH_VERIFICATION_CALLBACK_URL",
      "VITE_AUTH_VERIFICATION_CALLBACK_URL",
    ],
  });
}

export function buildPasswordResetEmailActionUrl({ url, token }) {
  return buildActionUrl({
    action: "reset-password",
    rawUrl: url,
    token,
    envNames: [
      "AUTH_PASSWORD_RESET_CALLBACK_URL",
      "VITE_AUTH_PASSWORD_RESET_CALLBACK_URL",
    ],
  });
}
