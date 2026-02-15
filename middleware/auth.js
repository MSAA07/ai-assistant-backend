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

      const email = session.user?.email?.toLowerCase?.() || "";
      const shouldElevate = adminEmails.has(email);
      const updates = {
        lastActive: new Date(),
      };

      if (shouldElevate && session.user.role !== "admin") {
        updates.role = "admin";
        req.session.user.role = "admin";
      }

      try {
        await prisma.user.update({
          where: { id: session.user.id },
          data: updates,
        });
      } catch (error) {
        console.error("Failed to update lastActive:", error);
      }

      next();
    } catch (error) {
      console.error("Auth check failed:", error);
      res.status(500).json({ error: "Auth check failed" });
    }
  };
};
