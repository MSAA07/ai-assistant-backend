import { isAllowedFrontendOrigin } from "../utils/frontendOrigins.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function getHeader(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function getOriginFromReferer(referer = "") {
  if (!referer) return "";

  try {
    return new URL(referer).origin;
  } catch {
    return "";
  }
}

export function isAllowedMutatingRequestOrigin(req) {
  const method = String(req.method || "").toUpperCase();
  if (!MUTATING_METHODS.has(method)) {
    return true;
  }

  const origin = getHeader(req, "origin");
  if (origin) {
    return isAllowedFrontendOrigin(origin);
  }

  const refererOrigin = getOriginFromReferer(getHeader(req, "referer"));
  if (refererOrigin) {
    return isAllowedFrontendOrigin(refererOrigin);
  }

  return true;
}

export function createMutatingOriginGuard() {
  return (req, res, next) => {
    if (isAllowedMutatingRequestOrigin(req)) {
      return next();
    }

    return res.status(403).json({ error: "Forbidden origin" });
  };
}
