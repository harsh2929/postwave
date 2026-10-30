// SPDX-License-Identifier: AGPL-3.0-only
//
// Display vocabulary shared by the AEO Sensor page and its panels. Mirrors the
// constants at the top of apps/desktop/src/pages/AEOSensor.tsx so the two
// surfaces label engines and categories identically.

import type { AEOEngine, AEOPromptCategory } from "@/lib/aeo-api";

export const PROMPT_CATEGORIES: { key: AEOPromptCategory; label: string }[] = [
  { key: "discovery", label: "Discovery" },
  { key: "comparison", label: "Comparison" },
  { key: "buyer", label: "Buyer" },
  { key: "support", label: "Support" },
  { key: "other", label: "Other" },
];

export const ENGINE_LABEL: Record<AEOEngine, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  perplexity: "Perplexity",
  grok: "Grok",
  copilot: "Copilot",
  _all: "All engines",
};

/** Engines the settings card lets an operator switch on or off. */
export const CONFIGURABLE_ENGINES: Exclude<AEOEngine, "_all">[] = [
  "chatgpt",
  "gemini",
  "perplexity",
  "grok",
  "copilot",
];

/** The three engines the per-engine snapshot always shows, populated or not. */
export const SNAPSHOT_ENGINES: AEOEngine[] = ["chatgpt", "gemini", "perplexity"];

export const MAX_BRAND_TERMS = 8;

/** A rate in [0,1] as a percentage string; non-finite input renders as a dash. */
export function pct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/** Volatility banding — mirrors desktop's scoreColor thresholds (60 / 30). */
export function volatilityTone(score: number): "danger" | "warning" | "ok" {
  if (score >= 60) return "danger";
  if (score >= 30) return "warning";
  return "ok";
}

/** "a, b , ,c" -> ["a","b","c"], capped. */
export function splitTerms(raw: string, cap?: number): string[] {
  const terms = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return cap === undefined ? terms : terms.slice(0, cap);
}
