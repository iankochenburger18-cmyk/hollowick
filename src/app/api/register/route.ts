import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { issueVerificationEmail } from "@/lib/email-verification";
import { sendTrialStartedEmail } from "@/lib/email";
import { computeCurrentPeriod } from "@/lib/plans";
import { FRONTEND_URL } from "@/lib/frontend-url";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : null;
  const password = typeof body?.password === "string" ? body.password : null;

  if (!email || !password || password.length < 8) {
    return NextResponse.json(
      { error: "Email and a password of at least 8 characters are required." },
      { status: 400 }
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "An account with that email already exists." }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  // Captured once and reused below (instead of a second `new Date()` later)
  // so the "trial ends on ___" date in the welcome email is computed from
  // the exact same instant that's actually stored as currentPeriodStart —
  // and run through computeCurrentPeriod() rather than hardcoding "+7 days"
  // again here, so this can never drift from PLAN_CONFIG.TRIAL.periodDays.
  const trialStart = new Date();

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      creditBalance: { create: { balance: 0 } },
      // Every new signup starts on a 7-day free trial with access to every
      // model (see PLAN_CONFIG.TRIAL in src/lib/plans.ts) and a credit
      // budget capped well under $5 of real provider cost.
      subscription: { create: { planTier: "TRIAL", currentPeriodStart: trialStart } },
    },
  });

  // Both of these are best-effort: a Resend outage or missing
  // RESEND_API_KEY shouldn't block signup — the account works immediately
  // either way (unverified accounts can sign in and use their trial same
  // as any other, see emailVerifiedAt on the User model). Sent in parallel,
  // and failures handled independently, so one failing never skips or
  // delays the other — a missed confirmation email can always be retried
  // via POST /api/verify-email/resend, but there's no equivalent resend for
  // the welcome email, so it's not worth letting a confirmation-email
  // hiccup take it down too.
  const trialPeriod = computeCurrentPeriod("TRIAL", trialStart);
  const [verificationResult, welcomeResult] = await Promise.allSettled([
    issueVerificationEmail(user.id, user.email),
    sendTrialStartedEmail(user.email, trialPeriod.end, `${FRONTEND_URL}/studio/`),
  ]);
  if (verificationResult.status === "rejected") {
    console.error(`register: failed to send verification email to ${user.email}:`, verificationResult.reason);
  }
  if (welcomeResult.status === "rejected") {
    console.error(`register: failed to send trial-started email to ${user.email}:`, welcomeResult.reason);
  }

  return NextResponse.json({ id: user.id, email: user.email }, { status: 201 });
}
