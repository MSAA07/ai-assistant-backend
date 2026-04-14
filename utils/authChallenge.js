const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function getChallengeProvider() {
  return (process.env.AUTH_CHALLENGE_PROVIDER || "turnstile").trim().toLowerCase();
}

function getTurnstileSecretKey() {
  return process.env.AUTH_TURNSTILE_SECRET_KEY?.trim() || "";
}

const DEFAULT_CHALLENGE_REQUIRED_ACTIONS = new Set([
  "sign_up",
  "sign_in",
  "forgot_password",
]);

export function isAuthChallengeConfigured() {
  return getChallengeProvider() === "turnstile" && Boolean(getTurnstileSecretKey());
}

export function isChallengeRequiredForAction(action) {
  if (!isAuthChallengeConfigured()) return false;

  const normalizedAction = String(action || "").trim().toLowerCase();
  if (!normalizedAction) return false;

  const envSpecific = process.env[`AUTH_CHALLENGE_REQUIRE_${normalizedAction.toUpperCase()}`];
  if (envSpecific != null && envSpecific !== "") {
    return parseBoolean(envSpecific, false);
  }

  return DEFAULT_CHALLENGE_REQUIRED_ACTIONS.has(normalizedAction);
}

export async function verifyAuthChallengeToken({
  token,
  ipAddress = "",
  action = "",
}) {
  if (!isAuthChallengeConfigured()) {
    return { ok: true, mode: "disabled" };
  }

  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) {
    return {
      ok: false,
      code: "challenge_required",
      message: "Please complete the security check and try again.",
    };
  }

  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      secret: getTurnstileSecretKey(),
      response: normalizedToken,
      ...(ipAddress ? { remoteip: ipAddress } : {}),
    }),
  });

  const payload = await response.json().catch(() => null);
  const success = Boolean(payload?.success);
  if (!response.ok || !success) {
    return {
      ok: false,
      code: "challenge_failed",
      message: "We could not verify the security check. Please try again.",
      provider: getChallengeProvider(),
      action,
      errorCodes: Array.isArray(payload?.["error-codes"]) ? payload["error-codes"] : [],
    };
  }

  return {
    ok: true,
    provider: getChallengeProvider(),
    action,
    hostname: payload?.hostname || "",
  };
}
