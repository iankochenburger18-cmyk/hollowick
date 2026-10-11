import { prisma } from "@/lib/prisma";

// Every account is meant to get a Subscription row the moment it's created
// (see src/app/api/register/route.ts — new signups start on a 7-day TRIAL).
// This is a safety net for any account that somehow doesn't have one yet —
// one that predates that logic, or was created outside the normal signup
// flow (seeded directly, migrated, etc.) — so a gap there shows up as "this
// account is on a trial" instead of a dead-end 403 the account has no way
// to resolve itself. GET /api/billing/status, POST /api/billing/checkout
// and POST /api/generate all go through this rather than a bare
// `prisma.subscription.findUnique` for exactly that reason.
//
// Return type is left to inference (rather than an explicit `Subscription`
// annotation) so this doesn't depend on that model type being a named
// export of the generated Prisma Client, which varies by Prisma version.
export async function getOrCreateSubscription(userId: string) {
  const existing = await prisma.subscription.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.subscription.create({
    data: { userId, planTier: "TRIAL", currentPeriodStart: new Date() },
  });
}
