// Central source of truth for Hollowick's tiered pricing model — mirrors
// hollowick_pricing_model.xlsx exactly. If the spreadsheet numbers ever
// change, update this file to match (and vice versa).
//
// The whole system runs on one idea: 1 credit = $0.01 of budgeted provider
// cost. GenerationJob.costCents stores a job's credit charge (the field
// name predates credits, but 1 credit === 1 cent here, so it's reused
// as-is). A plan's `monthlyCredits` is therefore a hard dollar ceiling on
// what that plan can cost Hollowick in a period, no matter which models the
// user actually picks.

export type PlanTierName = "TRIAL" | "STARTER" | "CREATOR" | "PRO" | "STUDIO";

const TRIAL_DAYS = 7;
const BILLING_PERIOD_DAYS = 30;

// Credit cost per generation, keyed by the UI-facing model name — these
// keys must match MODEL_TO_PROVIDER in src/lib/video-providers/index.ts
// (and MODELS in the frontend's studio.js) exactly.
export const MODEL_CREDIT_COST: Record<string, number> = {
  "MiniMax H3 Max Turbo": 13,
  "Ray3": 15,
  "Happy Horse 1.0": 19,
  "Kling 2.5": 21,
  "PixVerse v6": 23,
  "Happy Horse 1.1": 23,
  "Genjutsu": 23,
  "MiniMax Hailuo": 28,
  "Kling 2.6": 35,
  "Seedance 2.5": 37,
  "Kling 3.0": 56,
  "Gen-4.5": 60,
  "Seedance 2.0": 71,
  "Cinema Studio 4.0": 75,
  "LTX 2.5 Pro": 85,
  "Wan 2.7": 90,
  "Wan 3.0": 100,
  "LTX 2.5 Fast": 113,
  "Wan 3.0 Prime": 150,
  "Veo 3.1": 320,
};

const STARTER_MODELS = ["MiniMax H3 Max Turbo", "Ray3", "Happy Horse 1.0", "Kling 2.5"];
const CREATOR_MODELS = [
  ...STARTER_MODELS,
  "PixVerse v6",
  "Happy Horse 1.1",
  "Genjutsu",
  "MiniMax Hailuo",
  "Kling 2.6",
];
const PRO_MODELS = [
  ...CREATOR_MODELS,
  "Seedance 2.5",
  "Seedance 2.0",
  "Kling 3.0",
  "Gen-4.5",
  "Cinema Studio 4.0",
  "LTX 2.5 Pro",
  "Wan 2.7",
];
const STUDIO_MODELS = [
  ...PRO_MODELS,
  "Wan 3.0",
  "LTX 2.5 Fast",
  "Wan 3.0 Prime",
  "Veo 3.1",
];

export interface PlanConfig {
  label: string;
  /** null for TRIAL — it's not billed. */
  priceCents: number | null;
  monthlyCredits: number;
  periodDays: number;
  models: string[];
}

export const PLAN_CONFIG: Record<PlanTierName, PlanConfig> = {
  // 320 credits = the cost of a single Veo 3.1 generation (our most
  // expensive model), so a trial user can always make at least one
  // generation on literally any model. Worst case real spend is $3.20 at
  // assumed provider rates, and stays under the $5 cap even under the
  // pricing model's own +50% Veo-cost stress scenario ($4.80).
  TRIAL: { label: "Free trial", priceCents: null, monthlyCredits: 320, periodDays: TRIAL_DAYS, models: STUDIO_MODELS },
  STARTER: { label: "Starter", priceCents: 2900, monthlyCredits: 2400, periodDays: BILLING_PERIOD_DAYS, models: STARTER_MODELS },
  CREATOR: { label: "Creator", priceCents: 5900, monthlyCredits: 5100, periodDays: BILLING_PERIOD_DAYS, models: CREATOR_MODELS },
  PRO: { label: "Pro", priceCents: 11900, monthlyCredits: 10400, periodDays: BILLING_PERIOD_DAYS, models: PRO_MODELS },
  STUDIO: { label: "Studio", priceCents: 24900, monthlyCredits: 21900, periodDays: BILLING_PERIOD_DAYS, models: STUDIO_MODELS },
};

export function creditCostForModel(model: string): number | null {
  return MODEL_CREDIT_COST[model] ?? null;
}

export function isModelAllowed(tier: PlanTierName, model: string): boolean {
  return PLAN_CONFIG[tier].models.includes(model);
}

export interface CreditPeriod {
  start: Date;
  end: Date;
  /**
   * True once `end` has passed as of `now`. For paid tiers this never
   * comes back true — computeCurrentPeriod rolls the window forward until
   * it contains `now`. For TRIAL there's only ever one period, so an
   * elapsed trial just stays elapsed (the caller decides what that means —
   * see the generate route and dashboard page).
   */
  elapsed: boolean;
}

// Pure — never touches the database. Given a subscription's stored period
// start, works out what the *current* period boundaries should be right
// now. Paid tiers lazily roll forward in `periodDays`-sized chunks; the
// caller is responsible for persisting the result back onto the
// Subscription row when it differs from what was stored (see
// src/app/api/generate/route.ts).
export function computeCurrentPeriod(
  tier: PlanTierName,
  storedStart: Date,
  now: Date = new Date()
): CreditPeriod {
  const periodMs = PLAN_CONFIG[tier].periodDays * 24 * 60 * 60 * 1000;

  if (tier === "TRIAL") {
    const end = new Date(storedStart.getTime() + periodMs);
    return { start: storedStart, end, elapsed: now.getTime() > end.getTime() };
  }

  let start = storedStart;
  let end = new Date(start.getTime() + periodMs);
  while (now.getTime() > end.getTime()) {
    start = end;
    end = new Date(start.getTime() + periodMs);
  }
  return { start, end, elapsed: false };
}

// Statuses Stripe reports that mean "this customer currently has working,
// paid-for access." Kept here (rather than imported from src/lib/stripe.ts)
// so this file stays a dependency-free pure module — nothing in it needs a
// Stripe API key just to be imported.
const ACTIVE_STRIPE_STATUSES = new Set(["active", "trialing"]);

/**
 * Whether an account should be allowed to generate right now. TRIAL just
 * follows the period (same as before Stripe existed). A paid tier normally
 * has access too — `status` is only ever set once a Stripe subscription
 * exists, so a manually-assigned plan (e.g. edited directly in Supabase's
 * Table Editor, no Stripe involved) has `status: null` and keeps access.
 * Once Stripe *is* involved, a status outside ACTIVE_STRIPE_STATUSES means
 * the subscription was cancelled, a renewal payment failed and it lapsed,
 * etc. — see customer.subscription.deleted/updated in
 * src/app/api/billing/webhook/route.ts, which is what sets `status` to
 * something other than "active"/"trialing" in the first place.
 */
export function hasActiveAccess(
  tier: PlanTierName,
  status: string | null,
  period: CreditPeriod
): boolean {
  if (tier === "TRIAL") {
    return !period.elapsed;
  }
  if (status && !ACTIVE_STRIPE_STATUSES.has(status)) {
    return false;
  }
  return true;
}
