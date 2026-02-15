export const getMonthlyLimit = (user) => {
  const baseLimit = typeof user.monthlyLimit === "number" ? user.monthlyLimit : 5;
  const isPremium = user.plan === "premium" || user.role === "admin";
  const minLimit = isPremium ? 100 : 0;

  return Math.max(baseLimit, minLimit);
};

export const getRemainingDocuments = (user) => {
  return Math.max(getMonthlyLimit(user) - user.documentsUsed, 0);
};
