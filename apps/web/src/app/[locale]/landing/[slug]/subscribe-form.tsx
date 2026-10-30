// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { submitLandingConversion } from "@/lib/landing-api";

export function LandingSubscribeForm({
  slug,
  variantToken,
}: {
  slug: string;
  // LAND-037: echoed on conversion so the A/B arm the visitor saw is credited.
  variantToken?: string;
}) {
  const tLanding = useTranslations("landing");
  const tCommon = useTranslations("common");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">(
    "idle",
  );

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("saving");
    const ok = await submitLandingConversion(slug, email, variantToken);
    setState(ok ? "done" : "error");
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mt-7 grid max-w-2xl gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
      aria-busy={state === "saving"}
    >
      <Input
        type="email"
        required
        autoComplete="email"
        inputMode="email"
        placeholder={tLanding("email_placeholder")}
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
          if (state === "done" || state === "error") setState("idle");
        }}
        aria-label={tLanding("email_label")}
        aria-describedby={
          state === "done" || state === "error"
            ? "landing-subscribe-status"
            : undefined
        }
        className="min-h-11 min-w-0 bg-background text-base sm:text-sm"
      />
      <Button
        type="submit"
        loading={state === "saving"}
        className="min-h-11 px-5"
      >
        {state === "saving" ? tLanding("subscribing") : tCommon("subscribe")}
      </Button>
      {state === "done" || state === "error" ? (
        <p
          id="landing-subscribe-status"
          role={state === "error" ? "alert" : "status"}
          aria-live={state === "done" ? "polite" : undefined}
          className={
            state === "error"
              ? "text-sm font-medium text-destructive sm:col-span-2"
              : "text-sm font-medium text-emerald-700 sm:col-span-2"
          }
        >
          {state === "error"
            ? tLanding("subscribe_error")
            : tLanding("subscribed_confirmation")}
        </p>
      ) : null}
    </form>
  );
}
