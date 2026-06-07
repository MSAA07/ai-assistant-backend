import { betterAuth } from "better-auth";
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
    console.error(`[auth-email] ${context} failed:`, error);
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

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql", 
  }),
  baseURL: resolvedBetterAuthBaseURL,
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
