const getKey = (req, keyGenerator) => {
  if (keyGenerator) {
    return keyGenerator(req);
  }

  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }

  return req.ip || "unknown";
};

export const createRateLimiter = ({ windowMs = 60000, max = 120, keyGenerator }) => {
  const hits = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = getKey(req, keyGenerator);
    const entry = hits.get(key);

    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: "Too many requests" });
    }

    return next();
  };
};
