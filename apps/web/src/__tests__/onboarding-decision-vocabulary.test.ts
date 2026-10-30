// SPDX-License-Identifier: AGPL-3.0-only
//
// The onboarding DECISION vocabulary is written down in three places that must
// agree, and nothing checked that they did:
//
//   1. infra/migrations/1870_onboarding_step_state.sql — the CHECK constraint,
//      the only one of the three that can actually stop a bad row.
//   2. apps/api/internal/onboarding_progress/onboarding_progress.go — the
//      handler's `validStepStates`, which turns a violation into a 400 instead
//      of a 500.
//   3. @postwave/onboarding-schema — what web, desktop and mobile may write
//      and, more importantly, what each state MEANS for a surface.
//
// A client that silently ignores three of the five states is exactly how a
// decision stops travelling: the server records "inapplicable", every renderer
// understands only "dismissed", and the product goes on asking for a step the
// person already said was impossible for them. That failure is invisible to
// the CHECK constraint, so it needs its own guard.
//
// Also pinned here: the decision step keys must NOT collide with the derived
// checklist goal keys. Done-ness comes from EXISTS probes over real rows and a
// client cannot write it; if a decision key ever named a setup goal, a
// dismissal would start reading like progress.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHECKLIST_GOAL_KEYS,
  ONBOARDING_DECISION_STATES,
  ONBOARDING_DECISION_STEP_KEYS,
} from "@postwave/onboarding-schema";

const REPO = resolve(process.cwd(), "../..");
const HANDLER = readFileSync(
  join(REPO, "apps/api/internal/onboarding_progress/onboarding_progress.go"),
  "utf8",
);
const MIGRATION = readFileSync(
  join(REPO, "infra/migrations/1870_onboarding_step_state.sql"),
  "utf8",
);

/** States the Go handler accepts, read from its `validStepStates` map. */
function handlerStates(): string[] {
  const block = /var validStepStates = map\[string\]bool\{([\s\S]*?)\n\}/.exec(
    HANDLER,
  );
  if (!block?.[1]) throw new Error("validStepStates map not found in handler");
  return [...block[1].matchAll(/"([a-z_]+)":\s*true/g)].map((m) => m[1]!);
}

/** States the CHECK constraint allows, read from the migration. */
function constraintStates(): string[] {
  const block = /state = ANY \(ARRAY\[([^\]]*)\]\)/.exec(MIGRATION);
  if (!block?.[1]) throw new Error("state CHECK constraint not found");
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

describe("the decision vocabulary is one vocabulary", () => {
  it("guards the guard — both server sources are still readable", () => {
    // A renamed map or a rewritten constraint would make every check below
    // vacuously true; fail loudly instead.
    expect(handlerStates().length).toBeGreaterThan(0);
    expect(constraintStates().length).toBeGreaterThan(0);
  });

  it("the handler and the CHECK constraint agree", () => {
    expect(handlerStates().sort()).toEqual(constraintStates().sort());
  });

  it("the shared client schema agrees with the server", () => {
    expect([...ONBOARDING_DECISION_STATES].sort()).toEqual(
      handlerStates().sort(),
    );
  });
});

describe("clients honour every state, not just the convenient ones", () => {
  it("every server state has a defined client meaning", async () => {
    // `decisionHidesSurface` is the single place a renderer asks "does this
    // decision mean stop showing it?". Every state the server can store must
    // have an ANSWER there — true or false, but decided — otherwise a state
    // silently reads as "no decision" and the surface re-asks.
    const { decisionHidesSurface } = await import(
      "@postwave/onboarding-schema"
    );
    const meanings = new Map(
      handlerStates().map((state) => [state, decisionHidesSurface(state)]),
    );
    expect(Object.fromEntries(meanings)).toEqual({
      // "not now"
      dismissed: true,
      snoozed: false,
      // "not us" / "someone else has it" — the states that must stay gone.
      skipped: true,
      inapplicable: true,
      delegated: true,
    });
  });
});

describe("decision keys are not progress keys", () => {
  it("no decision step key collides with a derived checklist goal", () => {
    for (const key of ONBOARDING_DECISION_STEP_KEYS) {
      expect(CHECKLIST_GOAL_KEYS as readonly string[]).not.toContain(key);
    }
  });

  it("the server's PUT cannot be used to mark a step complete", () => {
    // The handler writes only (tenant, user, step_key, state, reason). If a
    // `completed` column ever appeared in that INSERT, a client could claim
    // done-ness the EXISTS probes never observed.
    const insert = /INSERT INTO onboarding_step_state \(([^)]*)\)/.exec(
      HANDLER,
    );
    expect(insert?.[1]).toBeDefined();
    expect(insert![1]!.split(",").map((c) => c.trim())).toEqual([
      "tenant_id",
      "user_id",
      "step_key",
      "state",
      "reason",
      "updated_at",
    ]);
  });
});
