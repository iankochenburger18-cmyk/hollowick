// Token issuance/verification for the email-confirmation flow. Kept
// separate from src/lib/email.ts (which only knows how to *send* mail) so
// that register/route.ts and the resend route share exactly one place that
// generates tokens, hashes them, and decides when a link is still good.
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { sendVerificationEmail } from "@/lib/email";

// Matches the "expires in 24 hours" copy baked into the email itself
// (src/lib/email.ts) — if this changes, that copy needs to change too.
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

// Issues a fresh token for this account and emails it. Any token(s) already
// outstanding for this user (e.g. from signup, if this is a resend) are
// deleted first — only the most recently sent link should ever work, so
// there's one obvious answer to "which email do I click" if more than one
// is sitting in an inbox. Throws if Resend fails to send; callers decide
// whether that should be fatal (register: no: see its try/catch; resend
// route: yes, since the user explicitly asked for this to happen now).
export async function issueVerificationEmail(userId: string, email: string): Promise<void> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await prisma.$transaction([
    prisma.emailVerificationToken.deleteMany({ where: { userId } }),
    prisma.emailVerificationToken.create({ data: { userId, tokenHash, expiresAt } }),
  ]);

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const verifyUrl = `${appUrl}/api/verify-email?token=${encodeURIComponent(rawToken)}`;

  await sendVerificationEmail(email, verifyUrl);
}

export type VerifyResult =
  | { ok: true; email: string }
  | { ok: false; reason: "invalid" | "expired" };

// Looks up a raw token (the ?token= query param on the emailed link) and,
// if it's valid and unexpired, marks the owning account verified and
// deletes every token row for that user. Deleting all of them (not just the
// one used) means a second tab still showing an older copy of the same
// email can't be used to re-trigger anything once the account is verified.
export async function verifyEmailToken(rawToken: string): Promise<VerifyResult> {
  const tokenHash = hashToken(rawToken);
  const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash } });
  if (!record) return { ok: false, reason: "invalid" };

  if (record.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const user = await prisma.user.update({
    where: { id: record.userId },
    data: { emailVerifiedAt: new Date() },
  });

  await prisma.emailVerificationToken.deleteMany({ where: { userId: record.userId } });

  return { ok: true, email: user.email };
}
