import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Simple in-memory cache: { 'userId:featureKey' => { value, expiresAt } }
const cache = new Map();
const CACHE_TTL_MS = 30 * 1000;

export async function isFeatureEnabled(featureKey, userId, userPlan) {
  const cacheKey = `${userId}:${featureKey}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const flag = await prisma.featureFlag.findUnique({
    where: { featureKey },
    include: { assignments: true },
  });

  if (!flag) {
    cache.set(cacheKey, { value: false, expiresAt: Date.now() + CACHE_TTL_MS });
    return false;
  }
  if (!flag.enabledGlobal) {
    cache.set(cacheKey, { value: false, expiresAt: Date.now() + CACHE_TTL_MS });
    return false;
  }

  const now = new Date();

  const userAssignment = flag.assignments.find(
    (assignment) => assignment.entityType === "user" && assignment.entityId === userId,
  );
  if (userAssignment) {
    const value = !userAssignment.expiresAt || userAssignment.expiresAt > now;
    cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  const tierAssignment = flag.assignments.find(
    (assignment) => assignment.entityType === "tier" && assignment.entityId === userPlan,
  );
  if (tierAssignment) {
    const value = !tierAssignment.expiresAt || tierAssignment.expiresAt > now;
    cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  cache.set(cacheKey, { value: true, expiresAt: Date.now() + CACHE_TTL_MS });
  return true;
}

export async function isFeatureEnabledIfConfigured(featureKey, userId, userPlan) {
  const flag = await prisma.featureFlag.findUnique({
    where: { featureKey },
    select: { id: true },
  });

  if (!flag) {
    return true;
  }

  return isFeatureEnabled(featureKey, userId, userPlan);
}

export function invalidateCache(featureKey) {
  for (const key of cache.keys()) {
    if (key.endsWith(`:${featureKey}`)) {
      cache.delete(key);
    }
  }
}

export async function toggleGlobalFlag(featureKey, enabled, adminUserId) {
  const flag = await prisma.featureFlag.update({
    where: { featureKey },
    data: { enabledGlobal: enabled },
  });

  await prisma.featureFlagAuditLog.create({
    data: {
      flagId: flag.id,
      changedBy: adminUserId,
      changeType: "global_toggle",
      newValue: { enabled },
    },
  });

  invalidateCache(featureKey);
  return flag;
}

export async function grantFeature(
  featureKey,
  entityType,
  entityId,
  grantedBy,
  expiresAt,
) {
  const flag = await prisma.featureFlag.findUnique({ where: { featureKey } });
  if (!flag) {
    throw new Error(`Flag ${featureKey} not found`);
  }

  const assignment = await prisma.featureFlagAssignment.create({
    data: {
      flagId: flag.id,
      entityType,
      entityId,
      grantedBy,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    },
  });

  await prisma.featureFlagAuditLog.create({
    data: {
      flagId: flag.id,
      changedBy: grantedBy,
      changeType: "grant",
      entityType,
      entityId,
    },
  });

  invalidateCache(featureKey);
  return assignment;
}

export async function revokeFeature(featureKey, entityType, entityId, changedBy) {
  const flag = await prisma.featureFlag.findUnique({ where: { featureKey } });
  if (!flag) {
    throw new Error(`Flag ${featureKey} not found`);
  }

  await prisma.featureFlagAssignment.deleteMany({
    where: { flagId: flag.id, entityType, entityId },
  });

  await prisma.featureFlagAuditLog.create({
    data: {
      flagId: flag.id,
      changedBy,
      changeType: "revoke",
      entityType,
      entityId,
    },
  });

  invalidateCache(featureKey);
}
