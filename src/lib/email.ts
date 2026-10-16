// Transactional email via Resend (resend.com) — email confirmation on
// signup, and the two trial-lifecycle emails sent by the worker's hourly
// scan (src/worker/index.ts): "your trial ends in 2 days" and "your trial
// has ended". Keeping this to one small module with one wrapper (send())
// means every email shares the same from-address handling, the same
// missing-API-key fallback behavior, and the same basic layout.

import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  // Same reasoning as src/lib/stripe.ts: don't throw at import time, since
  // plenty of code (the worker process in particular) imports things that
  // transitively touch this file without every request needing it. Each
  // send() call below fails loudly and individually instead.
  console.warn("RESEND_API_KEY is not set — outgoing email will fail until it's added to .env.");
}

const resend = new Resend(apiKey ?? "re_missing_RESEND_API_KEY");

// Must be an address on a domain verified in the Resend dashboard (Domains
// → Add Domain → add the DNS records it gives you for hollowick.app), or
// Resend will reject every send. Falls back to Resend's own shared test
// domain so a misconfigured deploy fails obviously rather than silently.
const FROM_ADDRESS = process.env.EMAIL_FROM ?? "Hollowick <onboarding@resend.dev>";

const INK = "#171815";
const LIME = "#d5ed83";
const MUTED = "#6b6f62";

function layout(preheader: string, bodyHtml: string): string {
  // Plain light-background HTML with inline styles only — the dark,
  // custom-font look of the actual site doesn't translate reliably across
  // email clients, so this deliberately isn't a reskin of the website, just
  // a plain, legible email that happens to use the brand's accent color.
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:Arial,Helvetica,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;">${preheader}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e0;">
        <tr><td style="padding:28px 32px 20px;border-bottom:1px solid #eeeee8;">
          <span style="font-size:18px;font-weight:700;color:${INK};">hollowick</span>
        </td></tr>
        <tr><td style="padding:28px 32px 32px;color:${INK};font-size:14px;line-height:1.6;">
          ${bodyHtml}
        </td></tr>
      </table>
      <p style="max-width:480px;margin:20px auto 0;color:${MUTED};font-size:11px;line-height:1.6;">
        Hollowick, ${new Date().getFullYear()}. You're receiving this because of activity on your Hollowick account.
      </p>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(label: string, href: string): string {
  return `<a href="${href}" style="display:inline-block;margin-top:20px;padding:13px 22px;background:${INK};color:${LIME};text-decoration:none;border-radius:40px;font-size:13px;font-weight:600;">${label}</a>`;
}

async function send(to: string, subject: string, html: string, text: string): Promise<void> {
  const { error } = await resend.emails.send({ from: FROM_ADDRESS, to, subject, html, text });
  if (error) {
    throw new Error(`Resend failed to send "${subject}" to ${to}: ${error.message}`);
  }
}

export async function sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
  const html = layout(
    "Confirm your email to finish setting up Hollowick.",
    `<p style="margin:0 0 4px;font-size:18px;font-weight:600;">Confirm your email</p>
     <p style="margin:0;">One click and you're set — this also helps us reach you if anything ever needs your attention.</p>
     ${button("Confirm email address", verifyUrl)}
     <p style="margin:24px 0 0;color:${MUTED};font-size:12px;">This link expires in 24 hours. If you didn't create a Hollowick account, you can ignore this email.</p>`
  );
  const text = `Confirm your Hollowick email address: ${verifyUrl}\n\nThis link expires in 24 hours. If you didn't create a Hollowick account, you can ignore this email.`;
  await send(to, "Confirm your email — Hollowick", html, text);
}

export async function sendTrialStartedEmail(to: string, trialEndsAt: Date, studioUrl: string): Promise<void> {
  const endLabel = trialEndsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const html = layout(
    "You're on the Hollowick free trial — 7 days, every model included.",
    `<p style="margin:0 0 4px;font-size:18px;font-weight:600;">You're on the free trial</p>
     <p style="margin:0;">Your 7-day free trial just started, with access to every video model. It runs through <strong>${endLabel}</strong> — pick a plan any time before then to keep generating without a gap.</p>
     ${button("Start creating", studioUrl)}`
  );
  const text = `You're on the Hollowick free trial — 7 days, every model included, through ${endLabel}. Pick a plan any time before then to keep generating without a gap: ${studioUrl}`;
  await send(to, "You're on the free trial — Hollowick", html, text);
}

export async function sendTrialEndingSoonEmail(to: string, daysLeft: number, pricingUrl: string): Promise<void> {
  const days = daysLeft === 1 ? "1 day" : `${daysLeft} days`;
  const html = layout(
    `Your Hollowick trial ends in ${days}.`,
    `<p style="margin:0 0 4px;font-size:18px;font-weight:600;">Your trial ends in ${days}</p>
     <p style="margin:0;">Pick a plan before then to keep generating without interruption — your account and credits carry straight over, nothing to redo.</p>
     ${button("Choose a plan", pricingUrl)}`
  );
  const text = `Your Hollowick free trial ends in ${days}. Pick a plan to keep generating without interruption: ${pricingUrl}`;
  await send(to, `Your Hollowick trial ends in ${days}`, html, text);
}

export async function sendTrialEndedEmail(to: string, pricingUrl: string): Promise<void> {
  const html = layout(
    "Your Hollowick trial has ended.",
    `<p style="margin:0 0 4px;font-size:18px;font-weight:600;">Your trial has ended</p>
     <p style="margin:0;">Your free trial has wrapped up, so new generations are paused for now. Pick a plan any time to pick up right where you left off.</p>
     ${button("Choose a plan", pricingUrl)}`
  );
  const text = `Your Hollowick free trial has ended. Pick a plan to keep generating: ${pricingUrl}`;
  await send(to, "Your Hollowick trial has ended", html, text);
}
