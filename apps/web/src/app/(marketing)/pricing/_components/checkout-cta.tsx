// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiErrorMessage } from "@/lib/api";
import { type BillingTier } from "@/lib/pricing";
import { createPublicCheckout } from "@/lib/public-billing-api";
import { track } from "@/lib/telemetry";
import { cn } from "@/lib/utils";

// Public self-serve checkout stays CLOSED by default ("production
// qualification"). Set NEXT_PUBLIC_ENABLE_PUBLIC_CHECKOUT=1 to open it: the
// paid tiers then start a hosted checkout session via the public billing
// endpoint. The API independently requires the billing launch approval and a
// complete, rehearsed provider configuration, so this client flag cannot open
// checkout by itself.
const PUBLIC_CHECKOUT_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_PUBLIC_CHECKOUT === "1";

function buttonClasses(isFeatured: boolean): string {
  return cn(
    "w-full",
    isFeatured ? "bg-pw-ember-500 hover:bg-pw-ember-600 text-white" : "",
  );
}

export function CheckoutCTA({
  tier,
  isFeatured,
  label,
}: {
  tier: BillingTier;
  isFeatured: boolean;
  label: string;
}): JSX.Element {
  if (tier === "sandbox") {
    return (
      <Button
        asChild
        className={buttonClasses(isFeatured)}
        variant={isFeatured ? "default" : "outline"}
      >
        <Link
          href="/signup"
          onClick={() => track("pricing_tier_clicked", { tier })}
        >
          {label}
        </Link>
      </Button>
    );
  }

  if (PUBLIC_CHECKOUT_ENABLED) {
    return (
      <PublicCheckoutCTA tier={tier} isFeatured={isFeatured} label={label} />
    );
  }

  return (
    <div className="space-y-2">
      <Button
        asChild
        className={buttonClasses(isFeatured)}
        variant={isFeatured ? "default" : "outline"}
      >
        <Link
          href={`mailto:sales@moosewave.com?subject=${encodeURIComponent(
            `Moosewave ${tier} waitlist`,
          )}`}
          onClick={() => track("pricing_tier_review_requested", { tier })}
        >
          {label}
        </Link>
      </Button>
      <p className="text-xs text-pw-muted-on-paper">
        Self-serve checkout is closed during production qualification. No
        payment is collected on the waitlist.
      </p>
    </div>
  );
}

/** The flag-on path: collect an email, then start a hosted checkout session. */
function PublicCheckoutCTA({
  tier,
  isFeatured,
  label,
}: {
  tier: BillingTier;
  isFeatured: boolean;
  label: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      track("pricing_checkout_started", { tier });
      const res = await createPublicCheckout({ tier, customerEmail: email });
      window.location.href = res.url;
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't start checkout. Try again."));
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button
        className={buttonClasses(isFeatured)}
        variant={isFeatured ? "default" : "outline"}
        onClick={() => {
          track("pricing_tier_clicked", { tier });
          setOpen(true);
        }}
      >
        {label}
      </Button>
    );
  }

  return (
    <form onSubmit={start} className="space-y-2">
      <Input
        type="email"
        required
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@company.com"
        aria-label="Work email for checkout"
        disabled={busy}
      />
      <Button
        type="submit"
        className={buttonClasses(isFeatured)}
        variant={isFeatured ? "default" : "outline"}
        disabled={busy || !email}
      >
        {busy ? "Starting checkout…" : "Continue to checkout"}
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
