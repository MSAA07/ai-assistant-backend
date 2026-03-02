import { isFeatureEnabled } from "../utils/featureFlags.js";

export function requireFeature(featureKey) {
  return async (req, res, next) => {
    const user = req.session?.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const enabled = await isFeatureEnabled(featureKey, user.id, user.plan);
    if (!enabled) {
      return res
        .status(403)
        .json({ error: "Feature not available", featureKey });
    }

    next();
  };
}
