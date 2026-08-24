import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

const ROUTING_CONFIGS = [
  { feature: "summary", plan: "free", model: "gpt-4.1-nano", reasoningEffort: null },
  { feature: "summary", plan: "premium", model: "gpt-4.1-nano", reasoningEffort: null },
  { feature: "flashcards", plan: "free", model: "gpt-4o-mini", reasoningEffort: null },
  { feature: "flashcards", plan: "premium", model: "gpt-4.1-mini", reasoningEffort: null },
  { feature: "exam", plan: "free", model: "gpt-5.4-mini", reasoningEffort: "low" },
  { feature: "exam", plan: "premium", model: "gpt-5.4-mini", reasoningEffort: "low" },
];

async function main() {
  for (const config of ROUTING_CONFIGS) {
    await prisma.modelRoutingConfig.upsert({
      where: {
        feature_plan: {
          feature: config.feature,
          plan: config.plan,
        },
      },
      update: {
        model: config.model,
        reasoningEffort: config.reasoningEffort,
      },
      create: config,
    });
  }

  console.log(`Seeded ${ROUTING_CONFIGS.length} model routing config rows.`);
}

main()
  .catch((error) => {
    console.error("Failed to seed model routing config:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
