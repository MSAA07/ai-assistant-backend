import { PrismaClient } from "@prisma/client";

const execute = process.argv.includes("--execute");
const allowedServices = new Set([
  "studymaxing-backend-staging",
  "studymaxing-worker-staging",
]);
const expectedDatabaseHost = "postgres-copy.railway.internal";
const serviceName = process.env.RAILWAY_SERVICE_NAME;
const databaseUrl = process.env.DATABASE_URL;

if (!allowedServices.has(serviceName)) {
  throw new Error(
    `Refusing to run outside staging; RAILWAY_SERVICE_NAME=${serviceName ?? "unset"}`,
  );
}

if (!databaseUrl || new URL(databaseUrl).hostname !== expectedDatabaseHost) {
  throw new Error("Refusing to run against a database other than Postgres Staging");
}

const prisma = new PrismaClient();

const duplicateGroupsSql = `
  SELECT
    "flagId",
    "entityType"::text AS "entityType",
    "entityId",
    COUNT(*)::int AS "rowCount"
  FROM "FeatureFlagAssignment"
  GROUP BY "flagId", "entityType", "entityId"
  HAVING COUNT(*) > 1
  ORDER BY "flagId", "entityType", "entityId"
`;

const rankedDuplicateRowsSql = `
  SELECT
    "id",
    "flagId",
    "entityType"::text AS "entityType",
    "entityId",
    "grantedBy",
    "grantedAt",
    "expiresAt",
    ROW_NUMBER() OVER (
      PARTITION BY "flagId", "entityType", "entityId"
      ORDER BY "grantedAt" DESC, "id" DESC
    )::int AS "keepRank"
  FROM "FeatureFlagAssignment"
  WHERE ("flagId", "entityType", "entityId") IN (
    SELECT "flagId", "entityType", "entityId"
    FROM "FeatureFlagAssignment"
    GROUP BY "flagId", "entityType", "entityId"
    HAVING COUNT(*) > 1
  )
  ORDER BY "flagId", "entityType", "entityId", "keepRank"
`;

function summarize(groups, rankedRows, tableRows) {
  const deleteRows = rankedRows.filter((row) => row.keepRank > 1);

  return {
    summary: {
      tableRows,
      duplicateGroups: groups.length,
      duplicateRows: rankedRows.length,
      rowsToDelete: deleteRows.length,
    },
    groups,
    rowsToKeep: rankedRows.filter((row) => row.keepRank === 1),
    rowsToDelete: deleteRows,
  };
}

async function inspect(db) {
  const groups = await db.$queryRawUnsafe(duplicateGroupsSql);
  const rankedRows = await db.$queryRawUnsafe(rankedDuplicateRowsSql);
  const [{ tableRows }] = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS "tableRows" FROM "FeatureFlagAssignment"`,
  );

  return summarize(groups, rankedRows, tableRows);
}

async function inspectRelatedTables(db) {
  const [counts] = await db.$queryRawUnsafe(`
    SELECT
      (SELECT COUNT(*)::int FROM "FeatureFlag") AS "featureFlagRows",
      (SELECT COUNT(*)::int FROM "FeatureFlagAuditLog") AS "auditLogRows"
  `);
  const auditEntityTypes = await db.$queryRawUnsafe(`
    SELECT "entityType", COUNT(*)::int AS "rowCount"
    FROM "FeatureFlagAuditLog"
    GROUP BY "entityType"
    ORDER BY "entityType" NULLS FIRST
  `);

  return { ...counts, auditEntityTypes };
}

try {
  if (!execute) {
    console.log(
      JSON.stringify(
        {
          ...(await inspect(prisma)),
          relatedTables: await inspectRelatedTables(prisma),
        },
        null,
        2,
      ),
    );
    process.exitCode = 0;
  } else {
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `LOCK TABLE "FeatureFlagAssignment" IN SHARE ROW EXCLUSIVE MODE`,
        );

        const before = await inspect(tx);
        const ids = before.rowsToDelete.map((row) => row.id);

        console.log("Exact rows selected for deletion:");
        console.log(JSON.stringify(before.rowsToDelete, null, 2));

        const deletion = ids.length
          ? await tx.featureFlagAssignment.deleteMany({
              where: { id: { in: ids } },
            })
          : { count: 0 };

        if (deletion.count !== ids.length) {
          throw new Error(
            `Expected to delete ${ids.length} rows, deleted ${deletion.count}`,
          );
        }

        const after = await inspect(tx);
        if (after.summary.duplicateGroups !== 0) {
          throw new Error("Duplicate groups remain; rolling back");
        }

        return { before, deletedRows: deletion.count, after };
      },
      { isolationLevel: "Serializable", timeout: 30_000 },
    );

    console.log("Deduplication committed:");
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await prisma.$disconnect();
}
