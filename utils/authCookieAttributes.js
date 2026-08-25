export function getAuthCookieAttributes({ baseURL = "", nodeEnv = "" } = {}) {
  let usesHttps = false;

  try {
    usesHttps = new URL(baseURL).protocol === "https:";
  } catch {
    usesHttps = false;
  }

  const useCrossSiteCookies = usesHttps || nodeEnv === "production";

  return {
    sameSite: useCrossSiteCookies ? "none" : "lax",
    secure: useCrossSiteCookies,
    partitioned: useCrossSiteCookies,
  };
}
