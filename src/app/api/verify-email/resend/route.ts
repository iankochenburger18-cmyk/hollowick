import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { issueVerificationEmail } from "@/lib/email-verification";

// Re-sends the confirmation email for the signed-in account. This is what
// backs the "resend confirmation email" nudge in the studio's account panel
// (src/studio.js on the frontend) for anyone who missed the first one,
// deleted it, or let its 24-hour link expire.
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!user) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }

  if (user.emailVerifiedAt) {
    return NextResponse.json({ error: "This email is already confirmed." }, { status: 400 });
  }

  try {
    await issueVerificationEmail(user.id, user.email);
  } catch (err) {
    // Unlike the best-effort send during signup (see /api/register), this
    // was an explicit action the user just took — if it fails, they should
    // hear about it rather than silently get nothing.
    const message = err instanceof Error ? err.message : "Could not send the confirmation email.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
