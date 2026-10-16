// The hourly trial-lifecycle-email scan, run by src/worker/index.ts on a
// BullMQ job scheduler (see upsertJobScheduler there). Looks at every
// account still on the free trial and sends whichever of the two lifecycle
// emails is now due:
//   - "your trial ends in N days" once the trial is within 2 days of ending
//   - "your trial has ended" once it actually has
// Each is sent at most once per account — see the stamped-timestamp fields
// below.
import { prisma } from "@/lib/prisma";
import { computeCurrentPeriod } from "@/lib/plans";
import { sendTrialEndingSoonEmail, sendTrialEndedEmail } from "@/lib/email";
import { FRONTEND_URL } from "@/lib/frontend-url";

const REMINDER_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // start reminding 2 days out
const DAY_MS = 24 * 60 * 60 * 1000;

const PRICING_URL = `${FRONTEND_URL}/pricing/`;

// `now` is a parameter (rather than always `new Date()` internally) purely
// so this is easy to unit-test later with a fixed clock; the real worker
// call site below doesn't pass one.
export async function scanAndSendLifecycleEmails(now: Date = new Date()): Promise<void> {
  // Only pulls accounts that still owe at least one of the two emails —
  // once both timestamps are set (or the account has left TRIAL for a paid
  // tier, which drops it out of this query entirely) there's nothing left
  // for this scan to ever do for that row again.
  const candidates = await prisma.subscription.findMany({
    where: {
      planTier: "TRIAL",
      OR: [{ trialReminderSentAt: null }, { trialEndedEmailSentAt: null }],
    },
    include: { user: { select: { email: true } } },
  });

  for (const subscription of candidates) {
    const email = subscription.user.email;

    try {
      const period = computeCurrentPeriod("TRIAL", subscription.currentPeriodStart, now);

      if (period.elapsed) {
        if (!subscription.trialEndedEmailSentAt) {
          await sendTrialEndedEmail(email, PRICING_URL);
          // Stamped immediately after a successful send so a second scan
          // (started before this one updates, or run concurrently) can't
          // double-send — see the catch below for what happens on failure.
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: { trialEndedEmailSentAt: now },
          });
        }
        continue;
      }

      if (!subscription.trialReminderSentAt) {
        const msLeft = period.end.getTime() - now.getTime();
        if (msLeft <= REMINDER_WINDOW_MS) {
          const daysLeft = Math.max(1, Math.ceil(msLeft / DAY_MS));
          await sendTrialEndingSoonEmail(email, daysLeft, PRICING_URL);
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: { trialReminderSentAt: now },
          });
        }
      }
    } catch (err) {
      // One account's send failing (bad address, a transient Resend
      // outage, etc.) shouldn't stop the rest of the batch. Nothing got
      // stamped for this one, so the next hourly pass just retries it.
      console.error(
        `lifecycle-emails: failed to process subscription ${subscription.id} (${email}):`,
        err
      );
    }
  }
}
