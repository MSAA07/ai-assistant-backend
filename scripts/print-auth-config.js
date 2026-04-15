import {
  getAllowedFrontendOrigins,
  isAllowedVercelPreviewOrigin,
} from "../utils/frontendOrigins.js";

function resolveBetterAuthBaseUrl() {
  const rawBaseUrl = process.env.BETTER_AUTH_URL ?? process.env.BETTER_AUTH_BASE_URL ?? "";
  const trimmed = rawBaseUrl.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!pathname || pathname === "/") {
      url.pathname = "/api/auth";
    } else if (!pathname.endsWith("/api/auth")) {
      url.pathname = `${pathname}/api/auth`;
    } else {
      url.pathname = pathname;
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

const configuredBaseURL = process.env.BETTER_AUTH_URL ?? process.env.BETTER_AUTH_BASE_URL ?? "";
const resolvedBetterAuthBaseURL = resolveBetterAuthBaseUrl();
const mode = process.env.NODE_ENV === "production" ? "production" : "non-production";
const senderEmail = process.env.AUTH_EMAIL_FROM_EMAIL?.trim() || "(missing)";
const senderName = process.env.AUTH_EMAIL_FROM_NAME?.trim() || "Studymaxing";
const replyTo = process.env.AUTH_EMAIL_REPLY_TO?.trim() || "(not set)";
const provider = process.env.AUTH_EMAIL_PROVIDER?.trim() || "resend";

console.log("[auth-config] mode:", mode);
console.log("[auth-config] betterAuthBaseURLConfigured:", configuredBaseURL || "(missing)");
console.log("[auth-config] betterAuthBaseURLResolved:", resolvedBetterAuthBaseURL || "(missing)");
console.log("[auth-config] emailProvider:", provider);
console.log("[auth-config] sender:", `${senderName} <${senderEmail}>`);
console.log("[auth-config] replyTo:", replyTo);
console.log("[auth-config] allowedFrontendOrigins:");
for (const origin of getAllowedFrontendOrigins()) {
  console.log(`- ${origin}`);
}
console.log(
  "[auth-config] vercelPreviewPattern: *.vercel.app containing 'my-ai-assistant' =>",
  isAllowedVercelPreviewOrigin("https://my-ai-assistant-sample-preview.vercel.app"),
);
