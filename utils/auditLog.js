import { captureSentryException } from "./sentry.js";

export const logAdminAction = async (prisma, { adminId, action, targetId, details, ipAddress }) => {
  try {
    await prisma.auditLog.create({
      data: {
        adminId,
        action,
        targetId,
        details,
        ipAddress,
      },
    });
  } catch (error) {
    console.error("Failed to write audit log:", error);
    captureSentryException(error, {
      tags: { util: "audit_log" },
      extra: { adminId, action, targetId },
    });
  }
};
