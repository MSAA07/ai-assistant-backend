import { isAllowedFrontendOrigin } from "./frontendOrigins.js";

const DEFAULT_FRONTEND_APP_URL = "https://studymaxing.com";

function getFirstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeAbsoluteUrl(value = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    return url.toString();
  } catch {
    return "";
  }
}

function getSafeFrontendActionBase(nextUrl = "", env = process.env) {
  const normalizedNextUrl = normalizeAbsoluteUrl(nextUrl);
  if (normalizedNextUrl) {
    const parsedNextUrl = new URL(normalizedNextUrl);
    if (isAllowedFrontendOrigin(parsedNextUrl.origin)) {
      return parsedNextUrl;
    }
  }

  const configuredAppUrl = normalizeAbsoluteUrl(env.AUTH_EMAIL_APP_URL || "");
  if (configuredAppUrl) {
    const parsedAppUrl = new URL(configuredAppUrl);
    if (isAllowedFrontendOrigin(parsedAppUrl.origin)) {
      return parsedAppUrl;
    }
  }

  return new URL(DEFAULT_FRONTEND_APP_URL);
}

export function buildFrontendAuthActionUrl({
  nextUrl = "",
  action,
  token = "",
  error = "",
  env = process.env,
} = {}) {
  const targetUrl = getSafeFrontendActionBase(getFirstQueryValue(nextUrl), env);
  targetUrl.searchParams.set("auth_action", action);

  const normalizedToken = getFirstQueryValue(token);
  if (normalizedToken) {
    targetUrl.searchParams.set("token", String(normalizedToken));
  } else {
    targetUrl.searchParams.delete("token");
  }

  const normalizedError = getFirstQueryValue(error);
  if (normalizedError) {
    targetUrl.searchParams.set("error", String(normalizedError).toLowerCase());
  } else {
    targetUrl.searchParams.delete("error");
  }

  return targetUrl.toString();
}

export function buildRelativeAuthBridgeCallbackPath({
  pathname,
  nextUrl = "",
  action,
  env = process.env,
} = {}) {
  const targetUrl = buildFrontendAuthActionUrl({
    nextUrl: getFirstQueryValue(nextUrl),
    action,
    env,
  });
  const params = new URLSearchParams({ next: targetUrl });
  return `${pathname}?${params.toString()}`;
}
