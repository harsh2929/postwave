// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  submitRoadmapFeedback,
  type RoadmapFeedbackState,
} from "@/lib/roadmap-feedback-api";

/**
 * Structured roadmap-feedback form (MKTC-019): pick the qualification
 * requirement that matters to you and subscribe to updates, without composing
 * an email. Submits through the public-forms endpoint; on success the person
 * receives the form's configured single- or double-opt-in outcome.
 */
export function RoadmapFeedbackForm({
  slug,
  options,
}: {
  slug: string;
  options: string[];
}) {
  const [email, setEmail] = useState("");
  const [requirement, setRequirement] = useState(options[0] ?? "");
  const [state, setState] = useState<
    "idle" | "saving" | "error" | RoadmapFeedbackState
  >("idle");
  const submitLockRef = useRef(false);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const requirementId = useId();

  useEffect(() => {
    if (
      state === "subscribed" ||
      state === "pending-confirmation" ||
      state === "received" ||
      state === "error"
    ) {
      feedbackRef.current?.focus();
    }
  }, [state]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLockRef.current || !email.trim() || !requirement) return;
    submitLockRef.current = true;
    setState("saving");
    try {
      const accepted = await submitRoadmapFeedback(
        slug,
        email.trim(),
        requirement,
      );
      setState(accepted ?? "error");
    } catch {
      setState("error");
    } finally {
      submitLockRef.current = false;
    }
  }

  if (
    state === "subscribed" ||
    state === "pending-confirmation" ||
    state === "received"
  ) {
    return (
      <div
        ref={feedbackRef}
        className="mx-auto mt-6 max-w-xl rounded-md border border-emerald-700/30 bg-emerald-50 p-4 text-left text-sm text-emerald-800 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
        role="status"
        tabIndex={-1}
      >
        <p>
          {state === "pending-confirmation"
            ? "Thanks — check your inbox to confirm and we’ll keep you posted."
            : state === "received"
              ? "Thanks — your feedback is recorded."
              : "Thanks — you’re subscribed and we’ll keep you posted."}{" "}
          Feedback informs priority but is not a delivery commitment.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mx-auto mt-6 flex max-w-xl flex-col gap-3 text-left"
      aria-busy={state === "saving"}
    >
      <label htmlFor={requirementId} className="text-sm font-medium">
        Which requirement matters most to you?
        <select
          id={requirementId}
          className="mt-1 h-11 w-full rounded-md border bg-background px-3 text-sm"
          value={requirement}
          disabled={state === "saving"}
          onChange={(event) => {
            setRequirement(event.target.value);
            if (state === "error") setState("idle");
          }}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          type="email"
          required
          placeholder="you@company.com"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (state === "error") setState("idle");
          }}
          aria-label="Email"
          autoComplete="email"
          maxLength={320}
          disabled={state === "saving"}
          className="h-11 bg-background"
        />
        <Button
          type="submit"
          size="lg"
          disabled={state === "saving"}
          loading={state === "saving"}
        >
          {state === "saving" ? "Sending…" : "Share requirement"}
        </Button>
      </div>
      {state === "error" && (
        <div
          ref={feedbackRef}
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="alert"
          tabIndex={-1}
        >
          The requirement could not be shared. Your selections are still here;
          review them and try again.
        </div>
      )}
    </form>
  );
}
