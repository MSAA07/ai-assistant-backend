export const toNumber = (value, fallback = 0) => {
  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "number") {
    return value;
  }

  return fallback;
};

export const serializeUser = (user) => {
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    plan: user.plan,
    banned: user.banned,
    banReason: user.banReason,
    banExpires: user.banExpires,
    documentsUsed: user.documentsUsed,
    monthlyLimit: user.monthlyLimit,
    storageUsed: toNumber(user.storageUsed),
    lastActive: user.lastActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
};
