import { captureSentryException } from "./sentry.js";

export const withAuditDiff = (auditData = {}) => {
  const details = auditData.details && typeof auditData.details === "object"
    ? auditData.details
    : null;
  const hasPreviousValue = Object.prototype.hasOwnProperty.call(auditData, "previousValue");
  const hasNewValue = Object.prototype.hasOwnProperty.call(auditData, "newValue");
  const previousValue = hasPreviousValue ? auditData.previousValue : details?.before;
  const newValue = hasNewValue ? auditData.newValue : details?.after ?? details?.updates;

  return {
    ...auditData,
    ...(previousValue !== undefined ? { previousValue } : {}),
    ...(newValue !== undefined ? { newValue } : {}),
  };
};

export const logAdminAction = async (prisma, auditData) => {
  const { adminId, action, targetId } = auditData;
  try {
    await prisma.auditLog.create({
      data: withAuditDiff(auditData),
    });
  } catch (error) {
    console.error("Failed to write audit log:", error);
    captureSentryException(error, {
      tags: { util: "audit_log" },
      extra: { adminId, action, targetId },
    });
  }
};
