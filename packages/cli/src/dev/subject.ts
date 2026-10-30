// SPDX-License-Identifier: MIT

import type { PostwaveClient } from "@postwave/sdk";

export interface SubjectSuggestion {
  subject: string;
  predicted: { primary: number; promotions: number; spam: number };
  rank: number;
}

interface SuggestRequest {
  html: string;
  candidates: string[];
}

const MAX_SUBJECT_CANDIDATES = 3;
const MAX_SUBJECT_CHARS = 180;
const MAX_HTML_CHARS = 200_000;

/**
 * Debounced subject co-pilot. Calls `inboxReality.predict` for each of
 * the supplied candidate subject lines and ranks them by the predicted
 * primary-tab placement.
 */
export class SubjectCopilot {
  private timer: NodeJS.Timeout | null = null;
  private inflight: AbortController | null = null;
  private lastResult: SubjectSuggestion[] = [];

  constructor(
    private readonly client: PostwaveClient,
    private readonly debounceMs: number = 1000,
  ) {}

  schedule(req: SuggestRequest, onResult: (s: SubjectSuggestion[]) => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.run(req, onResult);
    }, this.debounceMs);
  }

  async run(
    req: SuggestRequest,
    onResult: (s: SubjectSuggestion[]) => void,
  ): Promise<void> {
    if (this.inflight) this.inflight.abort();
    const ac = new AbortController();
    this.inflight = ac;
    try {
      const normalized = normalizeSuggestRequest(req);
      const results = await Promise.all(
        normalized.candidates.map((subject) =>
          this.client.inboxReality
            .predict({ html: normalized.html, subject })
            .then((r) => ({ subject, predicted: normalizePrediction(r.predicted) }))
            .catch(() => null),
        ),
      );
      const ranked: SubjectSuggestion[] = results
        .filter((x): x is { subject: string; predicted: SubjectSuggestion["predicted"] } => x !== null)
        .map((r, i) => ({ ...r, rank: i }))
        .sort((a, b) => b.predicted.primary - a.predicted.primary)
        .map((r, i) => ({ ...r, rank: i + 1 }));
      this.lastResult = ranked;
      if (!ac.signal.aborted) onResult(ranked);
    } finally {
      if (this.inflight === ac) this.inflight = null;
    }
  }

  last(): SubjectSuggestion[] {
    return this.lastResult;
  }
}

export function normalizeSubjectCandidates(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const subject = value.replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT_CHARS);
    if (!subject || seen.has(subject)) continue;
    seen.add(subject);
    out.push(subject);
    if (out.length >= MAX_SUBJECT_CANDIDATES) break;
  }
  return out;
}

function normalizeSuggestRequest(raw: SuggestRequest): SuggestRequest {
  const html = typeof raw.html === "string" ? raw.html.slice(0, MAX_HTML_CHARS) : "";
  return {
    html,
    candidates: normalizeSubjectCandidates(raw.candidates),
  };
}

function normalizePrediction(raw: SubjectSuggestion["predicted"]): SubjectSuggestion["predicted"] {
  return {
    primary: clampScore(raw.primary),
    promotions: clampScore(raw.promotions),
    spam: clampScore(raw.spam),
  };
}

function clampScore(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, n));
}
