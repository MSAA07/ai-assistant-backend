import { PrismaClient } from "@prisma/client";

import { repairPotentialUnicodeCorruption } from "../utils/filenames.js";

const prisma = new PrismaClient();
const SHOULD_REPAIR = process.argv.includes("--repair");
const SAMPLE_LIMIT = 25;
const SUSPICIOUS_TOKENS = ["Ã", "Ø", "Ù"];
const MOJIBAKE_PATTERN = /[ÃØÙ]/;

function isChanged(value) {
  const normalized = typeof value === "string" ? value : "";
  return repairPotentialUnicodeCorruption(normalized) !== normalized;
}

function buildContainsClauses(field) {
  return SUSPICIOUS_TOKENS.map((token) => ({
    [field]: { contains: token },
  }));
}

function summarizeRecords(records, valueKey) {
  return records.map((record) => ({
    ...record,
    looksSuspicious: MOJIBAKE_PATTERN.test(record[valueKey] || ""),
    wouldChange: isChanged(record[valueKey]),
    repairedPreview: repairPotentialUnicodeCorruption(record[valueKey]).slice(0, 140),
  }));
}

async function fetchEncodingDiagnostics() {
  const [dbInfo] = await prisma.$queryRaw`
    SELECT
      current_database() AS database,
      current_setting('server_encoding') AS server_encoding,
      current_setting('client_encoding') AS client_encoding
  `;
  return dbInfo;
}

async function fetchSuspiciousDocuments() {
  return prisma.document.findMany({
    where: {
      OR: [
        ...buildContainsClauses("originalName"),
        ...buildContainsClauses("summary"),
      ],
    },
    select: {
      id: true,
      originalName: true,
      summary: true,
    },
    take: SAMPLE_LIMIT,
    orderBy: { uploadDate: "desc" },
  });
}

async function fetchSuspiciousExcerpts() {
  return prisma.documentExcerpt.findMany({
    where: {
      OR: buildContainsClauses("content"),
    },
    select: {
      id: true,
      documentId: true,
      content: true,
    },
    take: SAMPLE_LIMIT,
    orderBy: { createdAt: "desc" },
  });
}

async function repairDocuments() {
  const documents = await prisma.document.findMany({
    select: {
      id: true,
      originalName: true,
      summary: true,
    },
  });

  let repaired = 0;
  for (const document of documents) {
    const nextOriginalName = repairPotentialUnicodeCorruption(document.originalName);
    const nextSummary = repairPotentialUnicodeCorruption(document.summary);
    if (nextOriginalName === document.originalName && nextSummary === document.summary) {
      continue;
    }

    await prisma.document.update({
      where: { id: document.id },
      data: {
        originalName: nextOriginalName,
        summary: nextSummary,
      },
    });
    repaired += 1;
  }

  return repaired;
}

async function repairExcerpts() {
  const excerpts = await prisma.documentExcerpt.findMany({
    where: {
      OR: buildContainsClauses("content"),
    },
    select: {
      id: true,
      content: true,
    },
  });

  let repaired = 0;
  for (const excerpt of excerpts) {
    const nextValue = repairPotentialUnicodeCorruption(excerpt.content);
    if (nextValue === excerpt.content) {
      continue;
    }

    await prisma.documentExcerpt.update({
      where: { id: excerpt.id },
      data: { content: nextValue },
    });
    repaired += 1;
  }

  return repaired;
}

async function main() {
  const encoding = await fetchEncodingDiagnostics();
  const [documents, excerpts] = await Promise.all([
    fetchSuspiciousDocuments(),
    fetchSuspiciousExcerpts(),
  ]);

  const suspiciousSummaries = documents
    .filter((document) => MOJIBAKE_PATTERN.test(document.summary || "") || isChanged(document.summary))
    .map((document) => ({
      id: document.id,
      originalName: document.originalName,
      summary: document.summary,
    }));

  console.log(JSON.stringify({
    encoding,
    suspiciousDocuments: summarizeRecords(documents, "originalName"),
    suspiciousSummaries: summarizeRecords(suspiciousSummaries, "summary"),
    suspiciousExcerpts: summarizeRecords(excerpts, "content"),
  }, null, 2));

  if (!SHOULD_REPAIR) {
    return;
  }

  const [documentsRepaired, excerptsRepaired] = await Promise.all([
    repairDocuments(),
    repairExcerpts(),
  ]);

  console.log(JSON.stringify({
    repaired: true,
    documentsRepaired,
    excerptsRepaired,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
