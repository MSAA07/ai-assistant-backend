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

function getPreferredCallbackUrl(envName, fallbackUrl) {
  return normalizeAbsoluteUrl(process.env[envName]) || normalizeAbsoluteUrl(fallbackUrl);
}

export function buildVerificationEmailActionUrl({ url, token }) {
  const callbackUrl = getPreferredCallbackUrl(
    "VITE_AUTH_VERIFICATION_CALLBACK_URL",
    extractCallbackUrl(url),
  );

  if (!callbackUrl || !token) {
    return url;
  }

  return buildFrontendActionUrl(callbackUrl, {
    auth_action: "verify-email",
    token,
  });
}

export function buildPasswordResetEmailActionUrl({ url, token }) {
  const callbackUrl = getPreferredCallbackUrl(
    "VITE_AUTH_PASSWORD_RESET_CALLBACK_URL",
    extractCallbackUrl(url),
  );

  if (!callbackUrl || !token) {
    return url;
  }

  return buildFrontendActionUrl(callbackUrl, {
    auth_action: "reset-password",
    token,
  });
}
