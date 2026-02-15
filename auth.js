import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { PrismaClient } from "@prisma/client";
import { admin } from "better-auth/plugins";

const prisma = new PrismaClient();

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql", 
  }),
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: [
    "http://localhost:5173",
    "http://localhost:5174",
    "https://my-ai-assistant-ypzx.vercel.app",
  ],
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
  }
});
