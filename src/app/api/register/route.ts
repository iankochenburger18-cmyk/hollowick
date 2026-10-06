import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

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

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      creditBalance: { create: { balance: 0 } },
      // Every new signup starts on a 7-day free trial with access to every
      // model (see PLAN_CONFIG.TRIAL in src/lib/plans.ts) and a credit
      // budget capped well under $5 of real provider cost.
      subscription: { create: { planTier: "TRIAL", currentPeriodStart: new Date() } },
    },
  });

  return NextResponse.json({ id: user.id, email: user.email }, { status: 201 });
}
