"use client";

import { useState } from "react";

// Posts to /api/billing/checkout and redirects the browser to the Stripe
// Checkout URL it returns. Access itself isn't granted here — that happens
// later when Stripe's webhook fires after the payment actually completes
// (see src/app/api/billing/webhook/route.ts); this button only starts that
// flow.
export function PlanCheckoutButton({ tier, label }: { tier: string; label: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.url) {
        setError(data?.error ?? "Something went wrong starting checkout.");
        setLoading(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Something went wrong starting checkout.");
      setLoading(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={handleClick} disabled={loading}>
        {loading ? "Redirecting…" : `Choose ${label}`}
      </button>
      {error ? <p>{error}</p> : null}
    </div>
  );
}
