import { captureSentryException } from "../utils/sentry.js";
import { consumeAuthRateLimit, getAuthRateLimitConfigSnapshot } from "../utils/authRateLimit.js";
import { isChallengeRequiredForAction, isAuthChallengeConfigured, verifyAuthChallengeToken } from "../utils/authChallenge.js";
import {
  getClientIpAddress,
  maskEmailAddress,
  maskIpAddress,
  normalizeEmailAddress,
  hashSensitiveValue,
  recordAuthEvent,
  recordAuthFailure,
} from "../utils/authTelemetry.js";

const AUTH_ACTIONS = {
  "POST /sign-up/email": { action: "sign_up", label: "sign-up", emailFromBody: true },
  "POST /sign-in/email": { action: "sign_in", label: "sign-in", emailFromBody: true },
  "POST /send-verification-email": { action: "resend_verification", label: "resend-verification", emailFromBody: true },
  "POST /request-password-reset": { action: "forgot_password", label: "forgot-password", emailFromBody: true },
  "POST /reset-password": { action: "reset_password", label: "reset-password", tokenFromBody: true },
  "POST /change-password": { action: "change_password", label: "change-password" },
  "GET /verify-email": { action: "verify_email", label: "verify-email" },
  "GET /get-session": { action: "get_session", label: "get-session" },
};

function getActionDescriptor(req) {
  const path = req.path || "/";
  return AUTH_ACTIONS[`${req.method.toUpperCase()} ${path}`] || null;
}

function getSupportEmail() {
  return process.env.AUTH_EMAIL_SUPPORT_EMAIL?.trim()
    || process.env.AUTH_EMAIL_REPLY_TO?.trim()
    || "";
}

function isBanExpired(user) {
  if (!user?.banned || !user?.banExpires) return false;
  return new Date(user.banExpires).getTime() <= Date.now();
}

async function normalizeBlockedUser(prisma, user) {
  if (!user) return null;

  if (isBanExpired(user)) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        banned: false,
        banReason: null,
        banExpires: null,
      },
    });
    return { ...user, banned: false, banReason: null, banExpires: null };
  }

  return user;
}

async function findUserByEmail(prisma, email) {
  const normalizedEmail = normalizeEmailAddress(email);
  if (!normalizedEmail) return null;

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      email: true,
      banned: true,
      banReason: true,
      banExpires: true,
      role: true,
    },
  });

  return normalizeBlockedUser(prisma, user);
}

async function deleteUserSessions(prisma, userId) {
  if (!userId) return 0;
  const result = await prisma.session.deleteMany({ where: { userId } });
  return result.count;
}

function sendAuthError(res, {
  status = 400,
  code = "request_failed",
  error = "Request failed",
  retryAfterSeconds = 0,
  details = undefined,
}) {
  if (retryAfterSeconds > 0) {
    res.setHeader("Retry-After", String(retryAfterSeconds));
  }

  return res.status(status).json({
    error,
    code,
    ...(retryAfterSeconds > 0 ? { retryAfterSeconds } : {}),
    ...(details ? { details } : {}),
  });
}

function buildRateLimitContext(descriptor, req, sessionUser) {
  const ipAddress = getClientIpAddress(req);
  const email = descriptor.emailFromBody ? normalizeEmailAddress(req.body?.email || "") : "";
  const rawToken = descriptor.tokenFromBody ? String(req.body?.token || "") : "";

  return {
    ipAddress,
    ipMasked: maskIpAddress(ipAddress),
    email,
    tokenKey: rawToken ? hashSensitiveValue(rawToken) : "",
    sessionKey: sessionUser?.id || "",
  };
}

function getChallengeToken(req) {
  const headerToken = req.headers["x-auth-challenge-token"];
  if (typeof headerToken === "string" && headerToken.trim()) {
    return headerToken.trim();
  }

  return String(req.body?.challengeToken || "").trim();
}

function attachOutcomeTelemetry(req, res, descriptor, context) {
  res.on("finish", () => {
    const baseDetails = {
      action: descriptor.action,
      path: req.path,
      method: req.method,
      status: res.statusCode,
      ip: context.ipMasked,
      email: maskEmailAddress(context.email),
    };

    if (descriptor.action === "verify_email") {
      recordAuthEvent("auth.verify_email.completed", {
        ...baseDetails,
        outcome: res.statusCode < 400 ? "success" : "failure",
      });
      return;
    }

    if (descriptor.action === "get_session") {
      recordAuthEvent("auth.get_session.completed", {
        ...baseDetails,
        outcome: res.statusCode < 400 ? "success" : "failure",
      });
      return;
    }

    recordAuthEvent(`auth.${descriptor.action}.completed`, {
      ...baseDetails,
      outcome: res.statusCode < 400 ? "success" : "failure",
    });
  });
}

export function getAuthSecurityDiagnostics() {
  return {
    rateLimit: getAuthRateLimitConfigSnapshot(),
    challenge: {
      provider: isAuthChallengeConfigured() ? "turnstile" : "disabled",
      supportEmail: getSupportEmail(),
    },
  };
}

export function createAuthHardeningMiddleware({ auth, prisma }) {
  return async (req, res, next) => {
    const descriptor = getActionDescriptor(req);
    if (!descriptor) {
      return next();
    }

    let sessionUser = null;

    try {
      if (descriptor.action === "change_password" || descriptor.action === "get_session") {
        const session = await auth.api.getSession({ headers: req.headers });
        sessionUser = session?.user || null;
      }

      const context = buildRateLimitContext(descriptor, req, sessionUser);
      attachOutcomeTelemetry(req, res, descriptor, context);

      if (descriptor.action === "get_session" && sessionUser?.id) {
        const user = await normalizeBlockedUser(prisma, await prisma.user.findUnique({
          where: { id: sessionUser.id },
          select: {
            id: true,
            email: true,
            banned: true,
            banReason: true,
            banExpires: true,
          },
        }));

        if (user?.banned) {
          const revokedSessions = await deleteUserSessions(prisma, user.id);
          recordAuthEvent("auth.blocked.session_restore", {
            outcome: "blocked",
            email: maskEmailAddress(user.email),
            ip: context.ipMasked,
            revokedSessions,
          });
          return sendAuthError(res, {
            status: 423,
            code: "account_suspended",
            error: "This account is suspended. Contact support for help.",
          });
        }
      }

      if (descriptor.action === "sign_in" && context.email) {
        const user = await findUserByEmail(prisma, context.email);
        if (user?.banned) {
          recordAuthEvent("auth.blocked.sign_in", {
            outcome: "blocked",
            email: maskEmailAddress(user.email),
            ip: context.ipMasked,
          });
          return sendAuthError(res, {
            status: 423,
            code: "account_suspended",
            error: "This account is suspended. Contact support for help.",
          });
        }
      }

      const rateLimitResult = consumeAuthRateLimit(descriptor.action, context);
      if (!rateLimitResult.allowed) {
        recordAuthEvent("auth.rate_limit.hit", {
          action: descriptor.action,
          path: req.path,
          ip: context.ipMasked,
          email: maskEmailAddress(context.email),
          retryAfterSeconds: rateLimitResult.retryAfterSeconds,
          rule: rateLimitResult.rule,
        });
        return sendAuthError(res, {
          status: 429,
          code: "rate_limited",
          error: "Too many authentication attempts. Please wait and try again.",
          retryAfterSeconds: rateLimitResult.retryAfterSeconds,
        });
      }

      if (isChallengeRequiredForAction(descriptor.action)) {
        const challengeResult = await verifyAuthChallengeToken({
          token: getChallengeToken(req),
          ipAddress: context.ipAddress,
          action: descriptor.action,
        });

        if (!challengeResult.ok) {
          recordAuthEvent("auth.challenge.failed", {
            action: descriptor.action,
            ip: context.ipMasked,
            email: maskEmailAddress(context.email),
            provider: challengeResult.provider || "turnstile",
            errorCodes: challengeResult.errorCodes || [],
            code: challengeResult.code,
          });
          return sendAuthError(res, {
            status: challengeResult.code === "challenge_required" ? 400 : 403,
            code: challengeResult.code,
            error: challengeResult.message,
          });
        }

        recordAuthEvent("auth.challenge.passed", {
          action: descriptor.action,
          ip: context.ipMasked,
          email: maskEmailAddress(context.email),
          provider: challengeResult.provider,
        });
      }

      if (req.body && Object.prototype.hasOwnProperty.call(req.body, "challengeToken")) {
        delete req.body.challengeToken;
      }

      return next();
    } catch (error) {
      recordAuthFailure("auth.middleware.failed", error, {
        action: descriptor.action,
        path: req.path,
        ip: maskIpAddress(getClientIpAddress(req)),
        email: maskEmailAddress(req.body?.email || ""),
      });
      captureSentryException(error, {
        tags: {
          feature: "auth",
          middleware: "auth-hardening",
          action: descriptor.action,
        },
      });
      return sendAuthError(res, {
        status: 500,
        code: "auth_guard_failed",
        error: "Authentication safeguards are temporarily unavailable. Please try again.",
      });
    }
  };
}
