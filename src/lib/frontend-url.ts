// Single source of truth for "which frontend origin to link back to" —
// used by backend routes/emails that need a link to the static marketing
// site (hollowick-site, on Vercel) rather than to this API. Mirrors the
// same fallback src/middleware.ts uses for FRONTEND_ORIGINS, and always
// takes the first configured origin as canonical even when more than one
// is allowlisted for CORS (e.g. production plus a local dev server).
export const FRONTEND_URL = (process.env.FRONTEND_ORIGINS || "https://hollowick.app")
  .split(",")[0]
  .trim();
