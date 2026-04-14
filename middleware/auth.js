import { captureSentryException } from "../utils/sentry.js";
import { maskEmailAddress, maskIpAddress, recordAuthEvent } from "../utils/authTelemetry.js";

const parseAdminEmails = () => {
  const raw = process.env.ADMIN_EMAILS || "";
  return new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
};

export const createRequireAuth = ({ auth, prisma }) => {
  const adminEmails = parseAdminEmails();

  return async (req, res, next) => {
    try {
      const session = await auth.api.getSession({
        headers: req.headers,
      });

      if (!session) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      req.session = session;

      const userRecord = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: {
          id: true,
          email: true,
          banned: true,
          banReason: true,
          banExpires: true,
          role: true,
        },
      });

      if (!userRecord) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      if (userRecord.banned && userRecord.banExpires && new Date(userRecord.banExpires).getTime() <= Date.now()) {
        await prisma.user.update({
          where: { id: userRecord.id },
          data: {
            banned: false,
            banReason: null,
            banExpires: null,
          },
        });
        userRecord.banned = false;
        userRecord.banReason = null;
        userRecord.banExpires = null;
      }

      if (userRecord.banned) {
        const revoked = await prisma.session.deleteMany({
          where: { userId: session.user.id },
        });
        recordAuthEvent("auth.blocked.protected_route", {
          outcome: "blocked",
          userId: session.user.id,
          email: maskEmailAddress(userRecord.email),
          ip: maskIpAddress(req.ip || req.socket?.remoteAddress || ""),
          revokedSessions: revoked.count,
          path: req.originalUrl || req.url,
        });
        return res.status(423).json({
          error: "This account is suspended. Contact support for help.",
          code: "account_suspended",
        });
      }

      const email = session.user?.email?.toLowerCase?.() || "";
      const shouldElevate = adminEmails.has(email);
      const updates = {
        lastActive: new Date(),
      };

      if (shouldElevate && session.user.role !== "admin") {
        updates.role = "admin";
        req.session.user.role = "admin";
      }

      if (userRecord.role && session.user.role !== userRecord.role) {
        req.session.user.role = userRecord.role;
      }

      try {
        await prisma.user.update({
          where: { id: session.user.id },
          data: updates,
        });
      } catch (error) {
        console.error("Failed to update lastActive:", error);
        captureSentryException(error, {
          tags: { middleware: "auth", phase: "last_active_update" },
        });
      }

      next();
    } catch (error) {
      console.error("Auth check failed:", error);
      captureSentryException(error, {
        tags: { middleware: "auth", phase: "session_check" },
      });
      res.status(500).json({ error: "Auth check failed" });
    }
  };
};
