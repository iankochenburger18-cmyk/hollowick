import { NextResponse } from "next/server";
import { verifyEmailToken } from "@/lib/email-verification";

// This is the actual link a confirmation email points at
// (api.hollowick.app/api/verify-email?token=...), so unlike the rest of
// /api/* it's meant to be opened directly in a browser tab, not fetch()'d
// by the frontend — hence a plain HTML response here instead of JSON, and
// no route on the hollowick-site side at all. FRONTEND_URL is only used to
// decide where its two buttons ("Sign in" / "Go to the studio") lead.
const FRONTEND_URL = (process.env.FRONTEND_ORIGINS || "https://hollowick.app")
  .split(",")[0]
  .trim();

const INK = "#171815";
const PAPER = "#f5f5f0";
const LIME = "#d5ed83";
const MUTED = "#b8bcae";
const PANEL = "#1f201c";
const LINE = "#2c2d27";

function page(title: string, message: string, href: string, label: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Hollowick</title>
</head>
<body style="margin:0;padding:0;background:${INK};font-family:Arial,Helvetica,sans-serif;color:${PAPER};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="min-height:100vh;">
    <tr><td align="center" style="padding:64px 16px;">
      <table role="presentation" width="100%" style="max-width:420px;">
        <tr><td align="center" style="padding-bottom:24px;font-size:20px;font-weight:700;letter-spacing:-0.02em;">
          hollowick
        </td></tr>
        <tr><td align="center" style="background:${PANEL};border:1px solid ${LINE};border-radius:16px;padding:36px 28px;">
          <p style="margin:0 0 8px;font-size:19px;font-weight:600;">${title}</p>
          <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:${MUTED};">${message}</p>
          <a href="${href}" style="display:inline-block;padding:13px 24px;background:${LIME};color:${INK};text-decoration:none;border-radius:40px;font-size:13px;font-weight:600;">${label}</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function htmlResponse(body: string, status: number): NextResponse {
  return new NextResponse(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");

  if (!token) {
    return htmlResponse(
      page(
        "Invalid link",
        "This confirmation link is missing its token — check that you copied the whole link from the email.",
        `${FRONTEND_URL}/signin/`,
        "Back to Hollowick"
      ),
      400
    );
  }

  const result = await verifyEmailToken(token);

  if (!result.ok) {
    const message =
      result.reason === "expired"
        ? "This confirmation link has expired. Sign in and use the resend option on your account to get a new one."
        : "This confirmation link is invalid — it may have already been used, or a newer link may have replaced it.";
    return htmlResponse(page("Link no longer works", message, `${FRONTEND_URL}/signin/`, "Sign in"), 400);
  }

  return htmlResponse(
    page(
      "Email confirmed",
      `${result.email} is confirmed. You're all set — head back to the studio to keep going.`,
      `${FRONTEND_URL}/studio/`,
      "Go to the studio"
    ),
    200
  );
}
