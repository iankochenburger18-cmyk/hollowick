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

// Which models bill proportionally to a user-chosen output length, and what
// duration (seconds) each MODEL_CREDIT_COST value above was calibrated
// against — i.e. the default every provider body-builder already falls
// back to (`duration ?? 5` etc. — see src/lib/video-providers/*.ts). Only
// a model whose adapter actually forwards a `duration` field to its
// provider belongs here; creditCostForModel() charges the flat
// MODEL_CREDIT_COST for everything else, same as before this feature.
//
// Two models are deliberately left out:
//   - Veo 3.1: veo.ts never sends a duration at all — Google's API returns
//     a fixed-length clip, so there's nothing to scale.
//   - Genjutsu: it's motion-transfer, not text-to-video — referenceBody()
//     in higgsfield.ts has no duration field either. Its real cost is
//     driven by the length of the *reference video* you supply, confirmed
//     against Higgsfield's own /estimate endpoint ($0.681/sec of reference
//     footage at 720p) — which is NOT what MODEL_CREDIT_COST currently
//     charges for it. That mismatch is a separate, already-known, not-yet-
//     fixed pricing issue and out of scope for this duration feature.
//
// Assumption worth flagging: this treats provider cost as linear in output
// duration for every model below (true for typical per-second video billing,
// but not individually re-verified against each provider's actual invoice
// the way Genjutsu's was) — revisit per-model if real spend says otherwise.
export const MODEL_BASE_DURATION_SECONDS: Record<string, number> = {
  "MiniMax H3 Max Turbo": 5,
  "Ray3": 5,
  "Happy Horse 1.0": 5,
  "Kling 2.5": 5,
  "PixVerse v6": 5,
  "Happy Horse 1.1": 5,
  "MiniMax Hailuo": 6,
  "Kling 2.6": 5,
  "Seedance 2.5": 5,
  "Kling 3.0": 5,
  "Gen-4.5": 5,
  "Seedance 2.0": 5,
  "Cinema Studio 4.0": 5,
  "LTX 2.5 Pro": 5,
  "Wan 2.7": 5,
  "Wan 3.0": 5,
  "LTX 2.5 Fast": 5,
  "Wan 3.0 Prime": 5,
};

// Shared bounds for every duration-configurable model — one generic range
// rather than per-model limits that haven't been individually verified
// against each provider's real min/max. A provider that rejects a value
// outside what it actually supports still surfaces its own validation
// error to the generation job, same as Runway's ratio validation already
// does elsewhere in this codebase — nothing new to handle for that case.
export const DURATION_MIN_SECONDS = 3;
export const DURATION_MAX_SECONDS = 20;

export function isDurationConfigurable(model: string): boolean {
  return Object.hasOwn(MODEL_BASE_DURATION_SECONDS, model);
}

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

// `durationSeconds` is the user's requested length (omit it, or pass
// undefined, for "auto" — the model's own default, which is exactly what
// every MODEL_CREDIT_COST value already charges for, so behavior for
// existing callers that never pass a duration is unchanged). For a model
// not in MODEL_BASE_DURATION_SECONDS (Veo 3.1, Genjutsu), any duration
// passed in is ignored and the flat cost always applies.
export function creditCostForModel(model: string, durationSeconds?: number): number | null {
  const flatCost = MODEL_CREDIT_COST[model];
  if (flatCost === undefined) return null;

  const baseDuration = MODEL_BASE_DURATION_SECONDS[model];
  if (!baseDuration || durationSeconds === undefined) return flatCost;

  const clamped = Math.min(DURATION_MAX_SECONDS, Math.max(DURATION_MIN_SECONDS, durationSeconds));
  // Linear with duration — see the "Assumption worth flagging" comment on
  // MODEL_BASE_DURATION_SECONDS above. Rounds up so we never undercharge a
  // fractional-credit sliver relative to the provider's actual per-second
  // rate.
  return Math.ceil((flatCost / baseDuration) * clamped);
}

export function isModelAllowed(tier: PlanTierName, model: string): boolean {
  return PLAN_CONFIG[tier].models.includes(model);
}

// À la carte pricing for unlocking one model on top of whatever plan an
// account is already on, without upgrading the whole plan — e.g. a STARTER
// account adding just Veo 3.1 instead of paying for all of STUDIO. This
// never changes monthly credits: a generation with an add-on model still
// draws from the plan's existing credit budget like any other model, so
// there's no new provider-cost exposure here, only new access being sold.
//
// How each price is set: find the cheapest tier a model is naturally
// included in, and look at that tier's price jump over the tier just below
// it (e.g. STARTER → CREATOR is a $30/mo jump that newly unlocks 5 models).
// Split that jump across those newly-unlocked models weighted by each
// model's own credit cost (MODEL_CREDIT_COST — a stand-in for how
// expensive/desirable it is, so Veo 3.1 is priced far above Wan 2.7 even
// though both happen to unlock at the same tier), then apply a 1.4×
// markup and round to a clean number.
//
// That 1.4× markup is the part that keeps upgrading the actual plan worth
// it: buying every model a tier newly unlocks, one at a time, always ends
// up costing more in total than just paying for that tier outright (which
// also bundles a much bigger credit budget for free) — while cherry-picking
// just one or two specific models stays clearly cheaper than a full tier
// jump. Confirmed against all three tier jumps when this was built; keep
// that property in mind before hand-editing any of these numbers.
//
// A price here is a snapshot at the moment someone buys it (see
// ModelAddon.priceCents in schema.prisma) — changing a number below only
// affects new add-on purchases, never ones already active.
export const MODEL_ADDON_PRICE_CENTS: Record<string, number> = {
  // Unlocked at CREATOR ($29 → $59, a $30/mo jump across these 5 models)
  "PixVerse v6": 750,
  "Happy Horse 1.1": 750,
  "Genjutsu": 750,
  "MiniMax Hailuo": 900,
  "Kling 2.6": 1100,

  // Unlocked at PRO ($59 → $119, a $60/mo jump across these 7 models)
  "Seedance 2.5": 650,
  "Kling 3.0": 1000,
  "Gen-4.5": 1050,
  "Seedance 2.0": 1250,
  "Cinema Studio 4.0": 1350,
  "LTX 2.5 Pro": 1500,
  "Wan 2.7": 1600,

  // Unlocked at STUDIO ($119 → $249, a $130/mo jump across these 4 models)
  "Wan 3.0": 2700,
  "LTX 2.5 Fast": 3000,
  "Wan 3.0 Prime": 4000,
  "Veo 3.1": 8500,
};

// null means this model isn't sellable as an add-on at all — either it's
// already in every paid tier (a STARTER model), or it's not a real model.
export function addonPriceForModel(model: string): number | null {
  return MODEL_ADDON_PRICE_CENTS[model] ?? null;
}

// Every model not already included in `tier`'s own plan — what the pricing
// page offers an account to add individually. Naturally empty for STUDIO
// (already has every model) and for TRIAL (already has every model too,
// for the length of the trial — see PLAN_CONFIG.TRIAL.models above).
export function upgradeableModelsForTier(tier: PlanTierName): string[] {
  const included = PLAN_CONFIG[tier].models;
  return Object.keys(MODEL_ADDON_PRICE_CENTS).filter((model) => !included.includes(model));
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
