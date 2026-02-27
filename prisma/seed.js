import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

const { auth } = await import("../auth.js");
const prisma = new PrismaClient();

const unwrapAuthResult = async (result) => {
  if (!result) return null;
  if (typeof Response !== "undefined" && result instanceof Response) {
    return result.json();
  }
  return result;
};

async function ensureAdminUser() {
  const adminEmail = "admin@ai.com";
  const adminPassword = "admin123";
  const adminName = "Admin";

  const existing = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (existing) {
    if (existing.role !== "admin" || !existing.emailVerified) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          role: "admin",
          emailVerified: true,
          plan: "premium",
          monthlyLimit: existing.monthlyLimit < 9999 ? 9999 : existing.monthlyLimit,
        },
      });
      console.log("✅ Existing admin user updated with elevated permissions.");
    } else {
      console.log("ℹ️ Admin user already exists. No changes made.");
    }
    return;
  }

  if (!auth?.api?.signUpEmail) {
    throw new Error("better-auth signUpEmail API is not available.");
  }

  console.log("👤 Creating admin user via better-auth...");
  const response = await unwrapAuthResult(
    await auth.api.signUpEmail({
      headers: { "content-type": "application/json" },
      body: {
        email: adminEmail,
        name: adminName,
        password: adminPassword,
      },
    }),
  );

  if (response?.error) {
    throw new Error(response.error?.message || "Failed to create admin user");
  }

  const createdUserId = response?.user?.id;
  if (createdUserId) {
    await prisma.user.update({
      where: { id: createdUserId },
      data: {
        emailVerified: true,
        plan: "premium",
        role: "admin",
        monthlyLimit: 9999,
      },
    });
  }

  console.log(`✅ Admin user created: ${adminEmail} / ${adminPassword}`);
}

async function main() {
  try {
    await ensureAdminUser();
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("❌ Seed failed:", error);
  process.exit(1);
});
