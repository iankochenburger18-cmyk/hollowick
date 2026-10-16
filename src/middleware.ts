import { NextResponse, type NextRequest } from "next/server";

// This backend is deployed at api.hollowick.app, while the marketing site
// (its /pricing/, /studio/ and /signin/ pages) is a separate static site on
// Vercel at hollowick.app — a different origin, even though they share the
// same registrable domain. Every browser fetch() from there to here needs
// CORS headers naming that exact origin (the spec forbids "*" once a
// request carries credentials), and any request with a JSON body triggers a
// CORS preflight (an OPTIONS request) that must get an answer before the
// browser will even send the real one.
//
// FRONTEND_ORIGINS is a comma-separated allowlist so this isn't hardcoded —
// production is just hollowick.app, but this also lets local frontend dev
// (hollowick-site's own dev server, see its server.mjs) hit a real backend
// if needed. See .env.example.
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGINS || "https://hollowick.app")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

function applyCors(response: NextResponse, origin: string | null) {
  // Only echo back an origin we actually recognize — never reflect an
  // arbitrary caller-supplied Origin header back as an allowed one.
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    // Tells any shared cache that the response varies by Origin, since the
    // allowed value isn't a fixed constant.
    response.headers.append("Vary", "Origin");
  }
  return response;
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get("origin");

  if (request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    // DELETE added for POST /api/billing/addons' sibling DELETE handler
    // (removing a model add-on) — every other route so far only ever
    // needed GET/POST.
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");
    response.headers.set("Access-Control-Max-Age", "86400");
    return applyCors(response, origin);
  }

  return applyCors(NextResponse.next(), origin);
}

// Only the API — the Next.js app's own pages (/dashboard, /signin, etc.)
// don't need CORS handling since the browser navigates to them directly
// rather than fetch()-ing them cross-origin.
export const config = {
  matcher: "/api/:path*",
};
