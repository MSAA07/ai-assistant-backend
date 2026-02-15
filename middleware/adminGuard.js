export const createRequireAdmin = ({ prisma }) => {
  return async (req, res, next) => {
    try {
      if (!req.session?.user?.id) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const user = await prisma.user.findUnique({
        where: { id: req.session.user.id },
        select: { role: true },
      });

      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
      }

      next();
    } catch (error) {
      console.error("Admin guard failed:", error);
      res.status(500).json({ error: "Admin guard failed" });
    }
  };
};
