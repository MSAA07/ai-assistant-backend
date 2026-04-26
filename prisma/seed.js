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

const FLAGS = [
  { featureKey: "document_summary", description: "On-demand document summaries (Phase F2)" },
  { featureKey: "flashcards", description: "On-demand flashcard generation (Phase F2)" },
  { featureKey: "exam", description: "On-demand exam generation (Phase F2)" },
  { featureKey: "pdf_export", description: "Export exams as PDF (Phase 5)" },
  {
    featureKey: "vision_model",
    description: "Image/diagram question generation (Phase 6)",
  },
  {
    featureKey: "anki_export",
    description: "Export flashcards to Anki format (Phase 4)",
  },
  {
    featureKey: "advanced_exam_types",
    description: "Fill-in-blank, matching, essay question types (Phase 3A)",
  },
  {
    featureKey: "exam_timer",
    description: "Countdown timer during exam (Phase 3B)",
  },
  {
    featureKey: "exam_review",
    description: "Review answers before submit (Phase 3B)",
  },
  {
    featureKey: "spaced_repetition",
    description: "SM-2 spaced repetition for flashcards (Phase 4)",
  },
  {
    featureKey: "smart_model_routing",
    description: "Automatic gpt-4o-mini vs gpt-4o routing (Phase 2)",
  },
  {
    featureKey: "USE_GPT55_SUMMARY",
    description: "Route summary generation to GPT-5.5 with the concise in-app study-summary prompt",
  },
];

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

async function seedFeatureFlags() {
  for (const flag of FLAGS) {
    await prisma.featureFlag.upsert({
      where: { featureKey: flag.featureKey },
      update: {},
      create: { ...flag, enabledGlobal: true },
    });
  }

  console.log("✅ Feature flags ensured");
}

async function main() {
  try {
    await ensureAdminUser();
    await seedFeatureFlags();
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("❌ Seed failed:", error);
  process.exit(1);
});
