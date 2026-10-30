module.exports = {
  DEFAULT_API_BASE_URL: "https://api.moosewave.com",
  PUBLIC_APP_BASE_URL: "https://app.moosewave.com",
  // Same defaults lib/config resolves to with no env override. The About
  // section dereferences these at RENDER time (`SOURCE_URL.replace(...)`), so
  // an absent export is a crash, not a missing string.
  SOURCE_URL: "https://github.com/postwave/postwave",
  PRIVACY_CONTACT_EMAIL: "privacy@moosewave.com",
  validateApiBaseUrl: (value) => ({ ok: true, url: value || "https://api.moosewave.com" }),
  // Mirrors lib/config's contract: https-only, null for anything unusable.
  // These are called at MODULE SCOPE by settings/legal components, so a
  // missing export here is not a failed assertion — it is an un-importable
  // route file, which takes the whole all-routes suite down with it.
  normalizeExternalAppUrl: (value) => {
    const raw = String(value ?? "").trim();
    return raw.startsWith("https://") ? raw : null;
  },
  normalizePublicHttpsUrl: (value, fallback) => {
    const raw = String(value ?? "").trim();
    return raw.startsWith("https://") ? raw : fallback;
  },
};
