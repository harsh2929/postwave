// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import {
  checkEmailBatch,
  checkSendWindow,
  generateSubjectVariants,
  scoreSubjectVariants,
  SUBJECT_LAB_AXES,
  type EmailVerdict,
  type ScoredSubjectVariant,
  type SendWindowCheck,
  type SubjectLabAxis,
} from "@/lib/preflight-api";
import { roleCanWrite } from "@/lib/use-admin-gate";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function PreflightAdvancedChecks({
  identity,
  subject,
}: {
  identity: MeResponse | null;
  subject: string;
}) {
  const canGenerate = Boolean(
    identity &&
      !identity.viewer_mode &&
      roleCanWrite(effectiveAuthRole(identity)),
  );
  const [scheduledAt, setScheduledAt] = useState("");
  const [windowResult, setWindowResult] = useState<SendWindowCheck | null>(null);
  const [windowPending, setWindowPending] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);
  const [axis, setAxis] = useState<SubjectLabAxis>("length");
  const [labPending, setLabPending] = useState(false);
  const [labError, setLabError] = useState<string | null>(null);
  const [variants, setVariants] = useState<string[]>([]);
  const [scores, setScores] = useState<ScoredSubjectVariant[]>([]);
  const [batch, setBatch] = useState("");
  const [batchPending, setBatchPending] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<EmailVerdict[]>([]);
  const labSequence = useRef(0);

  useEffect(() => {
    labSequence.current += 1;
    setVariants([]);
    setScores([]);
    setLabError(null);
  }, [subject]);

  async function runWindowCheck() {
    if (!identity || windowPending) return;
    setWindowPending(true);
    setWindowError(null);
    setWindowResult(null);
    try {
      setWindowResult(await checkSendWindow(new Date(scheduledAt).toISOString()));
    } catch (error) {
      setWindowError(
        error instanceof Error ? error.message : "Send window check failed.",
      );
    } finally {
      setWindowPending(false);
    }
  }

  async function runSubjectLab() {
    if (!canGenerate || labPending) return;
    const request = ++labSequence.current;
    setLabPending(true);
    setLabError(null);
    setVariants([]);
    setScores([]);
    try {
      const generated = await generateSubjectVariants({
        seedSubject: subject,
        axis,
        count: 6,
      });
      if (request !== labSequence.current) return;
      if ("refused" in generated) {
        setLabError(
          generated.refused.remedy
            ? `${generated.refused.message} Remedy: ${generated.refused.remedy.replaceAll("_", " ")}.`
            : `${generated.refused.message} This cannot be self-served.`,
        );
        return;
      }
      setVariants(generated.variants);
      if (generated.variants.length === 0) {
        setLabError("Subject Lab returned no variants.");
        return;
      }
      const scored = await scoreSubjectVariants(generated.variants);
      if (request !== labSequence.current) return;
      if ("insufficientHistory" in scored) {
        setLabError(
          "Variants were generated, but this workspace has insufficient sent history to score them.",
        );
        return;
      }
      setScores(scored.variants);
    } catch (error) {
      if (request === labSequence.current) {
        setLabError(
          error instanceof Error ? error.message : "Subject Lab failed.",
        );
      }
    } finally {
      if (request === labSequence.current) setLabPending(false);
    }
  }

  // generateSubjectVariants throws below ten characters before it ever reaches
  // the network. The field that decides this lives in a different section of
  // the page, so from here the button just looks dead — the reason has to be
  // said, and said for the role that can otherwise see no message at all.
  const seedTooShort = subject.trim().length < 10;
  const labDisabledReason = !canGenerate
    ? "Editor access outside viewer mode is required because generation can consume AI quota."
    : seedTooShort
      ? `Subject Lab needs a seed of at least 10 characters. The subject line above has ${subject.trim().length}.`
      : null;

  const parsedEmails = Array.from(
    new Set(
      batch
        .split(/[\n,]/u)
        .map((email) => email.trim())
        .filter(Boolean),
    ),
  );
  const batchValid =
    parsedEmails.length > 0 &&
    parsedEmails.length <= 100 &&
    parsedEmails.every((email) => email.length <= 254 && EMAIL_RE.test(email));

  async function runBatchCheck() {
    if (!identity || !batchValid || batchPending) return;
    setBatchPending(true);
    setBatchError(null);
    setVerdicts([]);
    try {
      setVerdicts(await checkEmailBatch(parsedEmails));
    } catch (error) {
      setBatchError(
        error instanceof Error ? error.message : "Batch address check failed.",
      );
    } finally {
      setBatchPending(false);
    }
  }

  return (
    <>
      <section aria-labelledby="pf-window" className="rounded-lg border p-4 sm:p-6">
        <h2 id="pf-window" className="text-base font-medium">Send window</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Check one candidate send time against the workspace policy.
        </p>
        <Input
          aria-label="Candidate send time"
          type="datetime-local"
          value={scheduledAt}
          disabled={windowPending}
          onChange={(event) => {
            setScheduledAt(event.target.value);
            setWindowResult(null);
            setWindowError(null);
          }}
          className="mt-3 max-w-sm"
        />
        <Button
          type="button"
          className="mt-3"
          disabled={!identity || !scheduledAt || windowPending}
          loading={windowPending}
          onClick={() => void runWindowCheck()}
        >
          {windowPending ? "Checking window…" : "Check send window"}
        </Button>
        <div aria-live="polite" aria-busy={windowPending}>
          {windowError ? <p className="mt-2 text-sm text-destructive">{windowError}</p> : null}
          {windowResult ? (
            <p className="mt-2 text-sm">
              {windowResult.enforcement === "off"
                ? "No send-window policy is enforcing this time; allow does not represent an approval."
                : `${windowResult.should.toUpperCase()}: ${windowResult.inside_window ? "inside" : "outside"} the configured window${windowResult.reason ? ` — ${windowResult.reason}` : ""}.`}
            </p>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="pf-lab" className="rounded-lg border p-4 sm:p-6">
        <h2 id="pf-lab" className="text-base font-medium">Subject Lab</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Generate six variants from the subject above, then score them against 180 days of workspace history.
        </p>
        <Select
          aria-label="Subject variation axis"
          value={axis}
          disabled={!canGenerate || labPending}
          onChange={(event) => setAxis(event.target.value as SubjectLabAxis)}
          className="mt-3 max-w-sm"
        >
          {SUBJECT_LAB_AXES.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
        <Button
          type="button"
          className="mt-3"
          disabled={!canGenerate || labPending || seedTooShort}
          loading={labPending}
          onClick={() => void runSubjectLab()}
          aria-describedby={labDisabledReason ? "pf-lab-reason" : undefined}
        >
          {labPending ? "Generating and scoring…" : "Generate and score variants"}
        </Button>
        {labDisabledReason ? (
          <p id="pf-lab-reason" className="mt-2 text-sm text-muted-foreground">{labDisabledReason}</p>
        ) : null}
        <div aria-live="polite" aria-busy={labPending}>
          {labError ? <p className="mt-2 text-sm text-destructive">{labError}</p> : null}
          {variants.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {variants.map((variant, index) => {
                const score = scores.find((row) => row.text === variant);
                return (
                  <li key={`${variant}-${index}`} className="rounded-md border p-3 text-sm">
                    <span>{variant}</span>
                    <span className="ml-2 text-muted-foreground">
                      {score ? `${(score.predicted_open * 100).toFixed(1)}% predicted open${score.low_confidence ? " · low confidence" : ""}` : "unscored"}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="pf-batch" className="rounded-lg border p-4 sm:p-6">
        <h2 id="pf-batch" className="text-base font-medium">Batch address preflight</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Read-only syntax, MX, disposable-domain and role-account checks for up to 100 addresses. This does not verify that a mailbox exists.
        </p>
        <Textarea
          aria-label="Email addresses"
          value={batch}
          disabled={batchPending}
          maxLength={25_500}
          rows={5}
          onChange={(event) => {
            setBatch(event.target.value);
            setVerdicts([]);
            setBatchError(null);
          }}
          className="mt-3 font-mono"
        />
        <Button
          type="button"
          className="mt-3"
          disabled={!identity || !batchValid || batchPending}
          loading={batchPending}
          onClick={() => void runBatchCheck()}
        >
          {batchPending ? "Checking addresses…" : "Check address batch"}
        </Button>
        {!batchValid && parsedEmails.length > 0 ? (
          <p className="mt-2 text-sm text-destructive">Enter 1–100 valid, bounded addresses separated by commas or new lines.</p>
        ) : null}
        <div aria-live="polite" aria-busy={batchPending}>
          {batchError ? <p className="mt-2 text-sm text-destructive">{batchError}</p> : null}
          {verdicts.length > 0 ? (
            <ul className="mt-3 divide-y rounded-md border">
              {verdicts.map((verdict, index) => (
                <li key={`${verdict.email}-${index}`} className="p-3 text-sm">
                  {verdict.email}: {verdict.verdict || "unknown"}
                  {verdict.reasons.length ? ` — ${verdict.reasons.join("; ")}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
    </>
  );
}
