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
//
// Always includes `modelAddons` (the à la carte models this account has
// unlocked on top of its plan tier — see src/lib/model-addons.ts) so every
// call site gets it for free rather than needing its own extra query.
//
// Filtered to removedAt: null — ModelAddon rows for a removed add-on are
// kept, not deleted, purely for admin history reporting (see the comment
// on ModelAddon.removedAt in schema.prisma), and were never meant to keep
// granting access or showing as "added" once removed. Centralizing the
// filter here means POST /api/generate's access check and GET
// /api/billing/addons's "already active" check (the two real call sites)
// don't each need to remember to exclude removed rows themselves.
export async function getOrCreateSubscription(userId: string) {
  const existing = await prisma.subscription.findUnique({
    where: { userId },
    include: { modelAddons: { where: { removedAt: null } } },
  });
  if (existing) return existing;
  return prisma.subscription.create({
    data: { userId, planTier: "TRIAL", currentPeriodStart: new Date() },
    include: { modelAddons: { where: { removedAt: null } } },
  });
}
