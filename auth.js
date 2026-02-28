import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { PrismaClient } from "@prisma/client";
import { admin } from "better-auth/plugins";

const prisma = new PrismaClient();

const isProduction = process.env.NODE_ENV === "production";

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql", 
  }),
  baseURL:
    process.env.BETTER_AUTH_URL ?? process.env.BETTER_AUTH_BASE_URL,
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: (request) => {
    const origin = request.headers.get("origin") || "";
    const allowedOrigins = [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://my-ai-assistant-ypzx.vercel.app",
      "https://my-ai-assistant-taupe.vercel.app",
      "https://my-ai-assistant-git-stage-msaa07.vercel.app",
      "https://my-ai-assistant-git-stage-mohammed-abushayiqahs-projects.vercel.app",
      "https://my-ai-assistant-git-production-mohammed-abushayiqahs-projects.vercel.app",
      "https://my-ai-assistant.vercel.app",
    ];
    // Also allow any Vercel preview deployment for this project
    if (origin.endsWith(".vercel.app") && origin.includes("my-ai-assistant")) {
      return [origin];
    }
    return allowedOrigins;
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
