// Free-trial abuse mitigation for POST /api/register — two independent,
// zero-friction checks that run before an account is created:
//
//   1. isDisposableOrInvalidEmail — rejects throwaway-email-service domains
//      (mailinator.com, yopmail.com, etc.) via the `mailchecker` package's
//      bundled 55,000+-domain blocklist, so one person can't just generate
//      a fresh inbox for every trial signup.
//   2. allowTrialSignupFromIp — caps trial signups to 3 per IP per 7 days,
//      so one person can't just re-register the same real email provider
//      (or a disposable one that slips past check #1) over and over from
//      one connection.
//
// Both are explicitly fail-open: a bug or outage in THIS file must never be
// the reason a legitimate signup is blocked. Letting a few extra trials
// through on a Redis hiccup costs a few dollars of model credit; blocking
// real signups because of it costs actual customers. See the try/catch in
// each function below.
import IORedis from "ioredis";
import MailChecker from "mailchecker";

const globalForAbuse = globalThis as unknown as {
  abuseRedisConnection: IORedis | undefined;
};

const redis =
  globalForAbuse.abuseRedisConnection ??
  new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });

if (process.env.NODE_ENV !== "production") {
  globalForAbuse.abuseRedisConnection = redis;
}

// True if `email` is malformed OR sits on mailchecker's disposable-domain
// blocklist (mailinator.com, yopmail.com, guerrillamail.com, and ~55,000
// more — see src/types/mailchecker.d.ts for why this needs a hand-written
// type declaration). Synchronous and local — no network call, so there's
// nothing here that can time out or fail open in the usual sense, but it's
// still wrapped below because a bad/empty bundled list or an unexpected
// throw from a third-party package shouldn't be able to take registration
// down either.
export function isDisposableOrInvalidEmail(email: string): boolean {
  try {
    return !MailChecker.isValid(email);
  } catch (error) {
    console.error(`abuse-prevention: MailChecker.isValid threw for an email check:`, error);
    return false; // fail open — let the signup through rather than block it.
  }
}

// Caddy (see Caddyfile) sits directly in front of the app and adds
// X-Forwarded-For itself — this isn't behind Cloudflare (confirmed: neither
// hollowick.app nor api.hollowick.app resolves to a Cloudflare IP), so
// there's no CF-Connecting-IP to prefer and no risk of a Cloudflare-specific
// header being spoofable-but-trusted here. The header can still carry a
// client-supplied value prepended before it reaches Caddy, but the LAST
// entry is the one Caddy itself appended from the actual TCP connection, so
// that's the one trustworthy hop closest to us — not the first, which is
// whatever the client claimed.
export function clientIpFromHeaders(headers: Headers): string | null {
  const forwardedFor = headers.get("x-forwarded-for");
  if (!forwardedFor) {
    return null;
  }
  const parts = forwardedFor.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

const TRIAL_SIGNUP_LIMIT = 3;
const TRIAL_SIGNUP_WINDOW_SECONDS = 7 * 24 * 60 * 60; // 7 days

// Fixed-window counter keyed by IP: the first signup from an IP in a given
// 7-day window sets the key to 1 with a 7-day expiry: every signup after
// that from the same IP within that same window just increments it, until
// either the window's 7 days elapse (the key expires and the next signup
// starts a fresh window) or the count hits the limit. Returns true (allow)
// if this signup would be at or under TRIAL_SIGNUP_LIMIT for its window,
// false (block) otherwise.
//
// Fails open on a null IP (nothing to key on) or ANY Redis error — see the
// file-level comment above for why. Deliberately does NOT try to decrement
// on a later failed/duplicate signup attempt; a few over-counted IPs
// costing a little false-positive friction is an acceptable trade for never
// having to reason about exactly-once accounting here.
export async function allowTrialSignupFromIp(ip: string | null): Promise<boolean> {
  if (!ip) {
    return true;
  }

  try {
    const key = `trial-signup-ip:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, TRIAL_SIGNUP_WINDOW_SECONDS);
    }
    return count <= TRIAL_SIGNUP_LIMIT;
  } catch (error) {
    console.error(`abuse-prevention: Redis rate-limit check failed for an IP, allowing the signup:`, error);
    return true;
  }
}
