import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const run = async () => {
  await prisma.user.updateMany({
    data: { storageUsed: BigInt(0) },
  });

  const summaries = await prisma.document.groupBy({
    by: ["userId"],
    _sum: { fileSize: true },
  });

  const updates = summaries.map((summary) =>
    prisma.user.update({
      where: { id: summary.userId },
      data: { storageUsed: BigInt(summary._sum.fileSize || 0) },
    }),
  );

  await prisma.$transaction(updates);

  const updatedUsers = await prisma.user.count();
  console.log(`Backfilled storage for ${updates.length} users.`);
  console.log(`Total users: ${updatedUsers}`);
};

run()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
