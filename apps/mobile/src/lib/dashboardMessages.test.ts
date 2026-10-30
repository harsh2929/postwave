/**
 * DASHBOARD#83 — proof that the dashboard's copy is actually TRANSLATABLE, not
 * merely tidied.
 *
 * `i18nCoverage.test.ts` proves the dashboard files contain no hardcoded
 * literals. That is necessary and not sufficient: a module could route every
 * string through `msg()` and still be untranslatable if the sentence frames
 * were assembled in code, or if the call sites read the base catalogue
 * directly. The only honest demonstration is to register a non-English
 * catalogue and watch the screen's copy change — including the frames that
 * carry a formatted age, whose whole point is that a translator can MOVE the
 * placeholder rather than being stuck with English word order.
 *
 * The fake catalogue below is deliberately not a real translation. It is
 * "pseudo-locale" text with the placeholder moved to the FRONT of the
 * sentence, which is the case that a `"…last read " + age` concatenation
 * could never express and this seam must.
 */
import { afterEach, describe, expect, it } from "vitest";

import { classifyDashboardFailure } from "./dashboardFailure";
import { dashboardLiveness } from "./dashboardLiveness";
import { tileSpokenSentence } from "./dashboardTileSpeech";
import { registerCatalogue, setMessageLocale } from "./i18n";
import { EN_MESSAGES } from "./messagesEn";

const XX = {
  "dashboard.live.label.live": "EN DIRECT",
  // Placeholder FIRST — the whole reason these are frames and not suffixes.
  "dashboard.live.spoken.live": "Lu {age} · le tableau de bord est en direct",
  "dashboard.failure.restricted.title": "Mesures restreintes",
  "dashboard.failure.restricted.body": "Votre rôle n'inclut pas l'analytique.",
} as const;

afterEach(() => {
  // Module-level locale state: leave the base catalogue active for anything
  // that runs after this file.
  setMessageLocale(undefined);
});

describe("dashboard copy is translatable", () => {
  it("reads the freshness badge from the active catalogue", () => {
    registerCatalogue("xx", XX);
    setMessageLocale("xx");
    const live = dashboardLiveness({
      lastUpdatedAt: 1_000,
      now: 2_000,
      stream: "live",
      age: "4m ago",
    });
    expect(live.label).toBe("EN DIRECT");
    // The age lands where the TRANSLATION puts it, not where English did.
    expect(live.spoken).toBe("Lu 4m ago · le tableau de bord est en direct");
  });

  it("reads the load-failure taxonomy from the active catalogue", () => {
    registerCatalogue("xx", XX);
    setMessageLocale("xx");
    const failure = classifyDashboardFailure({ status: 403 });
    expect(failure.kind).toBe("restricted");
    expect(failure.title).toBe("Mesures restreintes");
    expect(failure.message).toBe("Votre rôle n'inclut pas l'analytique.");
    // Untranslated keys degrade to English key-by-key rather than blanking the
    // notice — a partial catalogue must never produce an empty sentence.
    expect(classifyDashboardFailure({ status: 429 }).title).toBe(
      "Too many requests",
    );
  });

  it("renders English when no catalogue is registered", () => {
    setMessageLocale(undefined);
    expect(
      dashboardLiveness({
        lastUpdatedAt: 1_000,
        now: 2_000,
        stream: "live",
        age: "4m ago",
      }).spoken,
    ).toBe("Dashboard live. Changes arrive as they happen; last read 4m ago");
    expect(classifyDashboardFailure({ status: 403 }).title).toBe(
      "Metrics are restricted",
    );
  });
});

describe("the stat tiles are translatable", () => {
  it("picks a WHOLE spoken frame per shape rather than gluing clauses", () => {
    registerCatalogue("xx", {
      ...XX,
      // Destination first, value last — an order English never uses, which is
      // exactly what a frame assembled in code could not express.
      "dashboard.tile.a11y.anomalyDelta":
        "{destination} · {label} {delta} — anormal : {reason} — {value}",
    });
    setMessageLocale("xx");
    expect(
      tileSpokenSentence({
        label: "Bounce rate",
        spoken: "4.1%",
        delta: { text: "+2 30d" },
        destination: "Open analytics",
        anomaly: true,
        anomalyReason: "Bounces are high.",
      }),
    ).toBe(
      "Open analytics · Bounce rate +2 30d — anormal : Bounces are high. — 4.1%",
    );
  });

  it("falls back to the plain English frame with no catalogue", () => {
    setMessageLocale(undefined);
    expect(
      tileSpokenSentence({
        label: "Subscribers",
        // ABSENCE IS NOT ZERO — the tile prints an em-dash and VoiceOver must
        // hear a word, not the number nought.
        spoken: EN_MESSAGES["dashboard.tile.notReported"],
        destination: "Open subscribers",
      }),
    ).toBe("Subscribers, not reported. Open subscribers.");
  });
});
