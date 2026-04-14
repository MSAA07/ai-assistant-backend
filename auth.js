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
import { sendTransactionalEmail } from "./utils/email.js";
import { captureSentryException } from "./utils/sentry.js";

const prisma = new PrismaClient();

const isProduction = process.env.NODE_ENV === "production";
const supportEmail = process.env.AUTH_EMAIL_SUPPORT_EMAIL?.trim()
  || process.env.AUTH_EMAIL_REPLY_TO?.trim()
  || "";

async function sendAuthEmail(sendPromise, context) {
  try {
    return await sendPromise;
  } catch (error) {
    console.error(`[auth-email] ${context} failed:`, error);
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
  baseURL:
    process.env.BETTER_AUTH_URL ?? process.env.BETTER_AUTH_BASE_URL,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    autoSignIn: false,
    sendResetPassword: async ({ user, url }) => {
      const message = buildResetPasswordEmail({
        name: user.name,
        resetUrl: url,
        supportEmail,
      });

      await sendAuthEmail(
        sendTransactionalEmail({
          to: user.email,
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        "send-reset-password",
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
        }),
        "existing-user-signup",
      );
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    sendVerificationEmail: async ({ user, url }) => {
      const message = buildVerificationEmail({
        name: user.name,
        verificationUrl: url,
        supportEmail,
      });

      await sendAuthEmail(
        sendTransactionalEmail({
          to: user.email,
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        "send-verification",
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
