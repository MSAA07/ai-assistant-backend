import { betterAuth, generateId } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { PrismaClient } from "@prisma/client";
import { admin } from "better-auth/plugins";
import {
  getAllowedFrontendOrigins,
  isAllowedFrontendOrigin,
} from "./utils/frontendOrigins.js";
import {
  buildExistingUserSignUpEmail,
  buildResetPasswordEmail,
  buildVerificationEmail,
} from "./utils/authEmailTemplates.js";
import {
  buildPasswordResetEmailActionUrl,
  buildVerificationEmailActionUrl,
} from "./utils/authCallbackUrls.js";
import { sendTransactionalEmail } from "./utils/email.js";
import { captureSentryException } from "./utils/sentry.js";
import { maskEmailAddress, recordAuthEvent, recordAuthFailure } from "./utils/authTelemetry.js";

const prisma = new PrismaClient();

const isProduction = process.env.NODE_ENV === "production";
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

const supportEmail = process.env.AUTH_EMAIL_SUPPORT_EMAIL?.trim()
  || process.env.AUTH_EMAIL_REPLY_TO?.trim()
  || "";
export const resolvedBetterAuthBaseURL = resolveBetterAuthBaseUrl();

function normalizeEmailAddress(value = "") {
  return String(value).trim().toLowerCase();
}

function buildGenericSignUpResponseUser({ email, name, image }) {
  const now = new Date().toISOString();
  return {
    name: typeof name === "string" ? name.trim() : "",
    email: normalizeEmailAddress(email),
    emailVerified: false,
    image: typeof image === "string" && image.trim() ? image.trim() : null,
    createdAt: now,
    updatedAt: now,
    role: "user",
    banned: false,
    banReason: null,
    banExpires: null,
    plan: "free",
    documentsUsed: 0,
    monthlyLimit: 5,
    id: generateId(32),
  };
}

function buildGenericSignUpResponseBody(body = {}) {
  return {
    token: null,
    user: buildGenericSignUpResponseUser(body),
  };
}

async function sendAuthEmail(sendPromise, context, metadata = {}) {
  try {
    const result = await sendPromise;
    recordAuthEvent(`auth.email.${context}.success`, {
      outcome: "success",
      email: maskEmailAddress(metadata.email),
      context,
    });
    return result;
  } catch (error) {
    console.error(`[auth-email] ${context} failed:`, error instanceof Error ? error.message : String(error));
    recordAuthFailure(`auth.email.${context}.failure`, error, {
      context,
      email: maskEmailAddress(metadata.email),
    });
    captureSentryException(error, {
      tags: { authEmail: context },
    });
    throw error;
  }
}

async function sendExistingUserSignUpNotification(user) {
  const message = buildExistingUserSignUpEmail({ supportEmail });
  await sendAuthEmail(
    sendTransactionalEmail({
      to: user.email,
      subject: message.subject,
      html: message.html,
      text: message.text,
      context: "existing-user-signup",
    }),
    "existing-user-signup",
    { email: user.email },
  );
}

function createExistingUserSignUpEnumerationPlugin() {
  return {
    id: "existing-user-signup-enumeration",
    async onRequest(request) {
      if (request.method !== "POST") {
        return undefined;
      }

      const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
      if (!pathname.endsWith("/sign-up/email")) {
        return undefined;
      }

      const origin = request.headers.get("origin") || "";
      if (!isAllowedFrontendOrigin(origin)) {
        return undefined;
      }

      let body;
      try {
        body = await request.clone().json();
      } catch {
        return undefined;
      }

      const email = normalizeEmailAddress(body?.email || "");
      if (!email || !email.includes("@")) {
        return undefined;
      }

      const existingUser = await prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          emailVerified: true,
        },
      });

      if (!existingUser) {
        return undefined;
      }

      recordAuthEvent("auth.sign_up.existing_user.generic_response", {
        outcome: "success",
        email: maskEmailAddress(existingUser.email),
        emailVerified: Boolean(existingUser.emailVerified),
      });

      if (existingUser.emailVerified) {
        try {
          await sendExistingUserSignUpNotification(existingUser);
        } catch (error) {
          console.error(
            "[auth-email] existing-user signup notification failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      return {
        response: new Response(JSON.stringify(buildGenericSignUpResponseBody(body)), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }),
      };
    },
  };
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  baseURL: resolvedBetterAuthBaseURL,
  basePath: "/api/auth",
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    autoSignIn: false,
    sendResetPassword: async ({ user, url, token }) => {
      const resetUrl = buildPasswordResetEmailActionUrl({ url, token });
      const message = buildResetPasswordEmail({
        name: user.name,
        resetUrl,
        supportEmail,
      });

      await sendAuthEmail(
        sendTransactionalEmail({
          to: user.email,
          subject: message.subject,
          html: message.html,
          text: message.text,
          context: "send-reset-password",
        }),
        "send-reset-password",
        { email: user.email },
      );
    },
    customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
      ...coreFields,
      role: "user",
      banned: false,
      banReason: null,
      banExpires: null,
      ...additionalFields,
      id,
    }),
    onExistingUserSignUp: async ({ user }) => {
      await sendExistingUserSignUpNotification(user);
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: false,
    sendVerificationEmail: async ({ user, url, token }) => {
      const verificationUrl = buildVerificationEmailActionUrl({ url, token });
      const message = buildVerificationEmail({
        name: user.name,
        verificationUrl,
        supportEmail,
      });

      await sendAuthEmail(
        sendTransactionalEmail({
          to: user.email,
          subject: message.subject,
          html: message.html,
          text: message.text,
          context: "send-verification",
        }),
        "send-verification",
        { email: user.email },
      );
    },
  },
  trustedOrigins: (request) => {
    if (!request) return getAllowedFrontendOrigins();

    const origin = request.headers.get("origin") || "";
    if (isAllowedFrontendOrigin(origin)) {
      return [origin];
    }

    return getAllowedFrontendOrigins();
  },
  plugins: [
    createExistingUserSignUpEnumerationPlugin(),
    admin()
  ],
  user: {
    additionalFields: {
      plan: {
        type: "string",
        defaultValue: "free",
        required: false,
      },
      documentsUsed: {
        type: "number",
        defaultValue: 0,
      },
      monthlyLimit: {
        type: "number",
        defaultValue: 5,
      }
    }
  },
  advanced: {
    defaultCookieAttributes: {
      sameSite: isProduction ? "none" : "lax",
      secure: isProduction,
      partitioned: isProduction,
    },
  },
});
