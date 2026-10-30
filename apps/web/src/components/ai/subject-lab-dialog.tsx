// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Subject Lab (desktop SubjectLab parity): generate subject variants along one
 * axis, score them against the workspace's sent history, pick one, or hand
 * them to a new A/B test — every subject at an even split, or the top three
 * as a bandit.
 *
 * Rows sort by the LOW end of each confidence interval, so the safest bet
 * leads and a thinly-sampled variant cannot win on a lucky point estimate.
 * When scoring fails or the account has no history to score against, the
 * variants stay usable but are shown unscored, and the bandit (which needs a
 * ranking) is withheld with the reason.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { FlaskConical } from "lucide-react";

import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import type { SubjectTestReceipt } from "@/lib/campaign-copilot-api";
import {
  generateSubjectVariants,
  scoreSubjectVariants,
  SUBJECT_LAB_AXES,
  type EntitlementRefusal,
  type SubjectLabAxis,
} from "@/lib/preflight-api";
import { asRoute } from "@/lib/typed-routes";

const AXIS_LABELS: Record<SubjectLabAxis, string> = {
  length: "Length — short vs long",
  emoji: "Emoji — a leading emoji per variant",
  question: "Question — open-ended and yes/no",
  personalization: "Personalization — merge tags",
};

export const SUBJECT_LAB_MIN_SEED = 10;

interface LabRow {
  text: string;
  scored: boolean;
  predictedOpen: number;
  ciLow: number;
  ciHigh: number;
  matchedN: number;
  lowConfidence: boolean;
  belowBaseline: boolean;
}

interface LabResult {
  axis: SubjectLabAxis;
  rows: LabRow[];
  baselineOpen: number | null;
  windowDays: number | null;
  /** Why rows are unscored, when they are. */
  unscoredReason: string | null;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function unscored(variants: string[]): LabRow[] {
  return variants.map((text) => ({
    text,
    scored: false,
    predictedOpen: 0,
    ciLow: 0,
    ciHigh: 0,
    matchedN: 0,
    lowConfidence: true,
    belowBaseline: false,
  }));
}

export interface SubjectLabDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The saved subject the variants are anchored to. */
  seedSubject: string;
  bodyExcerpt?: string;
  /** write:campaigns — generating and scoring are editor calls. */
  canGenerate: boolean;
  generateBlockedReason: string;
  /** Replace the editor's subject. Omitted → no "Use" action is offered. */
  onUseVariant?: (subject: string) => void;
  /** Create a new A/B test from lab variants. Omitted → no test actions. */
  onStartTest?: (
    subjects: string[],
    bandit: boolean,
  ) => Promise<SubjectTestReceipt>;
  /** Why a test cannot be created from this campaign yet, or null. */
  testBlocker?: string | null;
}

export function SubjectLabDialog({
  open,
  onOpenChange,
  seedSubject,
  bodyExcerpt,
  canGenerate,
  generateBlockedReason,
  onUseVariant,
  onStartTest,
  testBlocker = null,
}: SubjectLabDialogProps) {
  const id = useId();
  const [axis, setAxis] = useState<SubjectLabAxis>("length");
  const [count, setCount] = useState(6);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<LabResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<EntitlementRefusal | null>(null);
  const [testing, setTesting] = useState<"bandit" | "all" | null>(null);
  const [receipt, setReceipt] = useState<SubjectTestReceipt | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const generation = useRef(0);
  const testingRef = useRef(false);

  const seed = seedSubject.trim();
  const seedReady = seed.length >= SUBJECT_LAB_MIN_SEED;

  // A different seed or body makes every row describe other copy.
  useEffect(() => {
    generation.current += 1;
    setGenerating(false);
    setResult(null);
    setError(null);
    setRefusal(null);
    setReceipt(null);
    setTestError(null);
  }, [seed, bodyExcerpt]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const sorted = useMemo(
    () =>
      result
        ? [...result.rows].sort((left, right) =>
            left.scored !== right.scored
              ? left.scored
                ? -1
                : 1
              : right.ciLow - left.ciLow,
          )
        : [],
    [result],
  );
  const scoredRows = sorted.filter((row) => row.scored);

  async function generate() {
    if (!canGenerate || !seedReady || generating) return;
    const token = ++generation.current;
    const requestAxis = axis;
    setGenerating(true);
    setError(null);
    setRefusal(null);
    setResult(null);
    setReceipt(null);
    setTestError(null);
    try {
      const generated = await generateSubjectVariants({
        seedSubject: seed,
        axis: requestAxis,
        count,
        bodyExcerpt,
      });
      if (token !== generation.current) return;
      if ("refused" in generated) {
        setRefusal(generated.refused);
        return;
      }
      const variants = Array.from(new Set(generated.variants));
      if (variants.length === 0) {
        setError("The generator returned no subject variants. Try again.");
        return;
      }
      let next: LabResult;
      try {
        const scores = await scoreSubjectVariants(variants);
        if ("insufficientHistory" in scores) {
          next = {
            axis: generated.axis,
            rows: unscored(variants),
            baselineOpen: null,
            windowDays: null,
            unscoredReason:
              "This workspace has no sent history to score against yet, so the variants are unscored. That is about the account, not the subject lines.",
          };
        } else {
          const byText = new Map(scores.variants.map((row) => [row.text, row]));
          next = {
            axis: generated.axis,
            rows: variants.map((text) => {
              const row = byText.get(text);
              return row
                ? {
                    text,
                    scored: true,
                    predictedOpen: row.predicted_open,
                    ciLow: row.ci_low,
                    ciHigh: row.ci_high,
                    matchedN: row.matched_n,
                    lowConfidence: row.low_confidence,
                    belowBaseline: row.below_baseline,
                  }
                : unscored([text])[0]!;
            }),
            baselineOpen: scores.baseline_open,
            windowDays: scores.window_days,
            unscoredReason: null,
          };
        }
      } catch (scoreError) {
        next = {
          axis: generated.axis,
          rows: unscored(variants),
          baselineOpen: null,
          windowDays: null,
          unscoredReason: `Scoring is unavailable (${apiErrorMessage(scoreError, "the scorer did not answer")}). The variants are still usable, unscored.`,
        };
      }
      if (token !== generation.current) return;
      setResult(next);
    } catch (generateError) {
      if (token !== generation.current) return;
      setError(
        apiErrorMessage(generateError, "Subject Lab could not generate variants."),
      );
    } finally {
      if (token === generation.current) setGenerating(false);
    }
  }

  async function startTest(bandit: boolean) {
    if (!onStartTest || testingRef.current) return;
    const subjects = bandit
      ? scoredRows.slice(0, 3).map((row) => row.text)
      : sorted.map((row) => row.text);
    testingRef.current = true;
    setTesting(bandit ? "bandit" : "all");
    setTestError(null);
    setReceipt(null);
    try {
      setReceipt(await onStartTest(subjects, bandit));
    } catch (cause) {
      setTestError(apiErrorMessage(cause, "The A/B test could not be created."));
    } finally {
      testingRef.current = false;
      setTesting(null);
    }
  }

  const generateReason = !canGenerate
    ? generateBlockedReason
    : !seedReady
      ? `Save a subject of at least ${SUBJECT_LAB_MIN_SEED} characters to seed the lab.`
      : null;
  const allReason =
    testBlocker ??
    (sorted.length < 2 ? "Generate at least two variants first." : null);
  const banditReason =
    testBlocker ??
    (scoredRows.length < 3
      ? result && result.unscoredReason
        ? "The bandit needs scored variants; scoring did not succeed."
        : "Generate at least three scored variants first."
      : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="size-4 text-primary" aria-hidden />
            Subject Lab
          </DialogTitle>
          <DialogDescription>
            Variants of “{seed || "(no saved subject)"}”, scored against your
            sent history. Pick one, or start a new A/B test from them — this
            campaign is not changed by a test.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-0 flex-1 gap-1.5">
            <Label htmlFor={`${id}-axis`}>Vary by</Label>
            <Select
              id={`${id}-axis`}
              value={axis}
              disabled={generating}
              onChange={(event) => {
                const next = event.target.value as SubjectLabAxis;
                if (SUBJECT_LAB_AXES.includes(next)) setAxis(next);
              }}
            >
              {SUBJECT_LAB_AXES.map((option) => (
                <option key={option} value={option}>
                  {AXIS_LABELS[option]}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-count`}>Variants</Label>
            <Select
              id={`${id}-count`}
              value={String(count)}
              disabled={generating}
              onChange={(event) => setCount(Number(event.target.value))}
            >
              {[5, 6, 7, 8].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </div>
          <Button
            type="button"
            loading={generating}
            disabled={generateReason !== null}
            aria-describedby={generateReason ? `${id}-generate-reason` : undefined}
            onClick={() => void generate()}
          >
            {generating ? "Generating…" : "Generate and score"}
          </Button>
        </div>
        {generateReason ? (
          <p id={`${id}-generate-reason`} className="text-xs text-muted-foreground">
            {generateReason}
          </p>
        ) : null}

        <div aria-live="polite" className="space-y-3">
          {refusal ? (
            <Alert variant="destructive">
              <AlertTitle>Subject Lab is not available to this workspace</AlertTitle>
              <AlertDescription>
                {refusal.message}
                {refusal.remedy ? ` Remedy: ${refusal.remedy.replace(/_/gu, " ")}.` : ""}
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {result ? (
            <>
              {result.unscoredReason ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {result.unscoredReason}
                </p>
              ) : result.baselineOpen !== null ? (
                <p className="text-xs text-muted-foreground">
                  Workspace baseline open rate {pct(result.baselineOpen)} over
                  the last {result.windowDays ?? 0} days. Rows lead with the
                  highest lower bound of a 90% interval.
                </p>
              ) : null}
              <ol
                aria-label="Subject Lab variants"
                className="divide-y rounded-lg border"
                data-testid="subject-lab-variants"
              >
                {sorted.map((row, index) => (
                  <li
                    key={row.text}
                    className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">
                        <span className="mr-2 tabular-nums text-muted-foreground">
                          {index + 1}.
                        </span>
                        {row.text}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                        {row.scored
                          ? `Predicted open ${pct(row.predictedOpen)} · 90% CI ${pct(row.ciLow)}–${pct(row.ciHigh)} · matched ${row.matchedN.toLocaleString()}`
                          : "Unscored"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {row.scored && (row.lowConfidence || row.belowBaseline) ? (
                        <Badge variant="outline">
                          {row.lowConfidence ? "Low confidence" : "Below baseline"}
                        </Badge>
                      ) : null}
                      {onUseVariant ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Use “${row.text}” as the subject`}
                          onClick={() => {
                            onUseVariant(row.text);
                            onOpenChange(false);
                          }}
                        >
                          Use
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
              <p className="text-[11px] leading-tight text-muted-foreground">
                {AI_DISCLOSURE_TEXT}
              </p>
            </>
          ) : null}
        </div>

        {onStartTest && result ? (
          <section
            aria-labelledby={`${id}-test`}
            aria-busy={testing !== null}
            className="space-y-2 border-t pt-3"
          >
            <h3 id={`${id}-test`} className="text-sm font-semibold">
              Start an A/B test from these variants
            </h3>
            <p className="text-xs text-muted-foreground">
              Creates a new draft A/B test with this campaign&apos;s saved body,
              sender and audience. Nothing sends until you send it.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                loading={testing === "bandit"}
                disabled={banditReason !== null || testing !== null}
                aria-describedby={`${id}-bandit-reason`}
                onClick={() => void startTest(true)}
              >
                Run top 3 as a bandit A/B
              </Button>
              <Button
                type="button"
                variant="outline"
                loading={testing === "all"}
                disabled={allReason !== null || testing !== null}
                aria-describedby={`${id}-all-reason`}
                onClick={() => void startTest(false)}
              >
                A/B test all {sorted.length} subjects
              </Button>
            </div>
            <p id={`${id}-bandit-reason`} className="text-xs text-muted-foreground">
              {banditReason ??
                "Bandit: Thompson sampling on opens shifts traffic toward the leader, keeping at least 10% exploring."}
            </p>
            <p id={`${id}-all-reason`} className="text-xs text-muted-foreground">
              {allReason ?? "All subjects: an even split across every variant."}
            </p>
            <div aria-live="polite">
              {testError ? (
                <Alert variant="destructive">
                  <AlertDescription>{testError}</AlertDescription>
                </Alert>
              ) : receipt ? (
                <div role="status" className="space-y-1 rounded-lg border p-3 text-sm">
                  <p>
                    Created draft A/B test “{receipt.name}” with{" "}
                    {receipt.variantCount} variants.
                    {receipt.bandit === "saved"
                      ? " Allocation: Thompson sampling on opens, 10% exploration floor."
                      : ""}
                  </p>
                  {receipt.bandit === "failed" ? (
                    <p className="text-destructive">
                      The bandit allocation was not saved ({receipt.banditError}
                      ). The test splits evenly until you set it on its A/B page.
                    </p>
                  ) : null}
                  <Link
                    className="text-primary underline-offset-2 hover:underline"
                    href={asRoute(
                      `/app/campaigns/${encodeURIComponent(receipt.parentId)}/ab`,
                    )}
                  >
                    Open the A/B test
                  </Link>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
