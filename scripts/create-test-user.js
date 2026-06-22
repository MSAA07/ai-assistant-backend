import { PrismaClient } from "@prisma/client";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";

dotenv.config();

const TEST_USER = {
  name: process.env.TEST_USER_NAME?.trim() || "Test User",
  email: process.env.TEST_USER_EMAIL?.trim().toLowerCase() || "",
  password: process.env.TEST_USER_PASSWORD || "",
  role: "user",
  plan: "free",
};

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Add it to ai-assistant-backend/.env before running this script.");
}

if (process.env.CONFIRM_STAGING_TEST_USER !== "yes") {
  throw new Error("Set CONFIRM_STAGING_TEST_USER=yes to confirm this script targets staging.");
}

if (!TEST_USER.email || !TEST_USER.password) {
  throw new Error("TEST_USER_EMAIL and TEST_USER_PASSWORD are required.");
}

const prisma = new PrismaClient();

async function main() {
  const email = TEST_USER.email.toLowerCase();
  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existingUser) {
    await prisma.user.delete({ where: { id: existingUser.id } });
  }

  const now = new Date();
  const passwordHash = await hashPassword(TEST_USER.password);
  const passwordValid = await verifyPassword({
    hash: passwordHash,
    password: TEST_USER.password,
  });

  if (!passwordValid) {
    throw new Error("Generated password hash failed verification.");
  }

  const user = await prisma.user.create({
    data: {
      name: TEST_USER.name,
      email,
      emailVerified: true,
      role: TEST_USER.role,
      plan: TEST_USER.plan,
      banned: false,
      banReason: null,
      banExpires: null,
      documentsUsed: 0,
      monthlyLimit: 5,
      storageUsed: 0n,
      lastReset: now,
      lastActive: now,
    },
    select: { id: true },
  });

  await prisma.account.create({
    data: {
      id: randomUUID(),
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    },
  });

  console.log(`Test user created: ${email}`);
}

main()
  .catch((error) => {
    console.error("Failed to create test user:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
