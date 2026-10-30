// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Pre-flight — the checks you run before a send.
 *
 * Five paths desktop reached and web did not, all of them POST, which is why
 * this is an action surface rather than a dashboard.
 *
 * The copy exists to stop four true-but-partial numbers reading as verdicts:
 *
 *   - The pre-send verdict is `complete: false` here; two of three components
 *     could not run. A passing verdict from an incomplete run is never allowed
 *     to render as "safe to send".
 *   - The send window says "allow" with enforcement OFF. Nothing is checking.
 *   - Subject expectations are 0 because `matched_history` is 0 — no basis,
 *     not a predicted zero.
 *   - Subject Lab answers a structured refusal with a remedy; an absent remedy
 *     means the operator cannot self-serve, which is said rather than papered
 *     over with a button.
 *
 * BOTH GRADED CHECKS ARE ABOUT ONE SENDER ADDRESS, AND THE OPERATOR SUPPLIES
 * IT. The server resolves SPF/DKIM/DMARC for whatever `from` it is handed, so
 * a defaulted or placeholder address grades a domain this workspace does not
 * own — and the page would then report that as a finding about their setup,
 * sending them to fix DNS they never configured. Nothing is graded until there
 * is a real sender and a real draft to grade.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import { canWriteCampaigns } from "@/lib/campaign-write-authority";
import { getDnsHealth } from "@/lib/deliverability-hub-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  checkAccessibility,
  checkEmail,
  deliverableButUnwise,
  expectationsUnfounded,
  getEqScore,
  passingButIncomplete,
  scoreSubject,
  type A11yReport,
  type EmailVerdict,
  type EqScore,
  type PresendComponent,
  type PresendVerdict,
  type SubjectScore,
  unavailableComponents,
  weakestComponent,
} from "@/lib/preflight-api";
import { base, STALE } from "@/lib/query-keys";
import { PreflightAdvancedChecks } from "./preflight-advanced-checks";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function wireText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Posted here rather than through `getPresendVerdict()`, which sends a fixed
 * empty body. An empty body is not "no input" to this endpoint — the server
 * scores an empty subject and an unresolvable sender and answers with a real
 * verdict sentence ("Critical issues detected…"), which an operator reads as
 * the state of their own sending. The draft on this page goes in the body so
 * the sentence is about something.
 */
async function requestPresendVerdict(input: {
  from: string;
  subject: string;
  html: string;
}): Promise<PresendVerdict> {
  const r = await api.post<Record<string, unknown>>(
    "/api/v1/presend/verdict",
    input,
    // Grading a draft persists nothing: never mint a mutation identity that
    // would leave a replayable receipt in the idempotency ledger.
    { idempotencyKey: null },
  );
  const rows: unknown = r?.components;
  return {
    verdict: wireText(r?.verdict),
    complete: r?.complete === true,
    summary: wireText(r?.summary),
    components: (Array.isArray(rows) ? rows : []).map(
      (row): PresendComponent => {
        const c = (row ?? {}) as Record<string, unknown>;
        return {
          name: wireText(c.name),
          status: wireText(c.status),
          score: typeof c.score === "number" ? c.score : undefined,
          message: wireText(c.message) || undefined,
          error: wireText(c.error) || undefined,
        };
      },
    ),
    computed_at: wireText(r?.computed_at),
  };
}

export default function PreflightPage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const keyBase = useMemo(
    () =>
      base(
        "preflight",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  // Both graded checks POST behind write:campaigns, which the server grants to
  // owner/admin/editor and refuses to a viewer — including an owner in
  // View-as-Viewer. Firing them anyway turns a 403 into "could not compute",
  // indistinguishable from an outage, behind a Retry that can never succeed.
  const canRunGradedChecks = canWriteCampaigns(meQuery.data);
  const gradedChecksBlocked = meQuery.isPending
    ? "Checking your access…"
    : meQuery.isError
      ? "Your access could not be verified, so nothing was graded."
      : canRunGradedChecks
        ? null
        : "Owner, admin, or editor access outside viewer mode is required to run the graded checks.";

  // Read-only (read:reports), so every role can see which domains the graded
  // checks are actually able to authenticate.
  const dns = useQuery({
    queryKey: [...keyBase, "sending-identities"],
    queryFn: getDnsHealth,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });
  const verifiedDomains = useMemo(
    () =>
      (Array.isArray(dns.data) ? dns.data : [])
        .filter((identity) => identity.verify_state === "verified")
        .map((identity) => String(identity.domain ?? "").trim().toLowerCase())
        .filter(Boolean),
    [dns.data],
  );

  const [from, setFrom] = useState("");
  const [verdict, setVerdict] = useState<PresendVerdict | null>(null);
  const [verdictPending, setVerdictPending] = useState(false);
  const [verdictError, setVerdictError] = useState<string | null>(null);

  const [subject, setSubject] = useState("Your invoice is ready");
  const [score, setScore] = useState<SubjectScore | null>(null);
  const [scoring, setScoring] = useState(false);
  const [scoreError, setScoreError] = useState<string | null>(null);

  const [html, setHtml] = useState('<img src="hero.png">');
  const [report, setReport] = useState<A11yReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [a11yError, setA11yError] = useState<string | null>(null);

  async function runScore() {
    setScoring(true);
    setScoreError(null);
    setScore(null);
    try {
      setScore(await scoreSubject(subject));
    } catch {
      setScoreError("Could not score that subject line.");
    } finally {
      setScoring(false);
    }
  }

  async function runA11y() {
    setChecking(true);
    setA11yError(null);
    setReport(null);
    try {
      setReport(await checkAccessibility(html));
    } catch {
      setA11yError("Could not check that markup.");
    } finally {
      setChecking(false);
    }
  }

  const [addr, setAddr] = useState("info@example.com");
  const [emailVerdict, setEmailVerdict] = useState<EmailVerdict | null>(null);
  const [checkingEmail, setCheckingEmail] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const [eq, setEq] = useState<EqScore | null>(null);
  const [scoringEq, setScoringEq] = useState(false);
  const [eqError, setEqError] = useState<string | null>(null);

  async function runEmailCheck() {
    setCheckingEmail(true);
    setEmailError(null);
    setEmailVerdict(null);
    try {
      setEmailVerdict(await checkEmail(addr));
    } catch {
      setEmailError(
        "Could not check that address. No deliverability verdict is available.",
      );
    } finally {
      setCheckingEmail(false);
    }
  }

  const fromAddress = from.trim();
  const fromValid = EMAIL_RE.test(fromAddress);
  const fromDomain = fromValid
    ? fromAddress.slice(fromAddress.lastIndexOf("@") + 1).toLowerCase()
    : "";
  // Only meaningful once the identity list has actually arrived: an unloaded
  // or failed list is "not known", never "not verified".
  const senderDomainUnverified =
    fromValid && dns.isSuccess && !verifiedDomains.includes(fromDomain);
  // Nothing is graded on a value the operator cannot see. Every input the two
  // scoring endpoints read is on this page and non-empty before either runs.
  const draftReady = fromValid && subject.trim() !== "" && html.trim() !== "";
  // The list is disabled — and therefore permanently `pending` — while whoami
  // is failing, so an unresolved identity has to be named here or the hint
  // reads "Loading…" for ever.
  const senderDomainHint =
    meQuery.isError || dns.isError
      ? "Could not load this workspace's verified sending domains, so the address you enter cannot be checked against them."
      : dns.isPending
        ? "Loading this workspace's verified sending domains…"
        : verifiedDomains.length === 0
          ? "No sending domain is verified in this workspace yet, so sender authentication will score as unverified whichever address you enter."
          : `Verified sending ${verifiedDomains.length === 1 ? "domain" : "domains"}: ${verifiedDomains.join(", ")}.`;

  async function runVerdict() {
    if (!canRunGradedChecks || !draftReady || verdictPending) return;
    setVerdictPending(true);
    setVerdictError(null);
    setVerdict(null);
    try {
      setVerdict(
        await requestPresendVerdict({ from: fromAddress, subject, html }),
      );
    } catch {
      setVerdictError(
        "Could not compute a pre-send verdict. No pass is being inferred.",
      );
    } finally {
      setVerdictPending(false);
    }
  }

  async function runEqScore() {
    if (!canRunGradedChecks || !draftReady || scoringEq) return;
    setScoringEq(true);
    setEqError(null);
    setEq(null);
    try {
      setEq(await getEqScore({ from: fromAddress, subject, html }));
    } catch {
      setEqError(
        "Could not score this send. No deliverability grade is available.",
      );
    } finally {
      setScoringEq(false);
    }
  }

  const stalled = verdict ? unavailableComponents(verdict) : [];
  const addressValid = EMAIL_RE.test(addr.trim());

  return (
    <PageShell className="max-w-4xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Pre-flight
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Check a send before it goes out — content, accessibility and timing.
        </p>
      </header>

      <section
        aria-labelledby="pf-sender"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="pf-sender" className="text-base font-medium">
          Sender address
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The pre-send verdict and the deliverability score both resolve SPF,
          DKIM and DMARC for this address&rsquo;s domain. There is deliberately
          no default: a stand-in address would grade a domain this workspace
          does not own and report the result as your setup.
        </p>
        <label htmlFor="pf-from" className="mt-3 block text-sm">
          From
        </label>
        <Input
          id="pf-from"
          type="email"
          inputMode="email"
          autoComplete="off"
          value={from}
          disabled={verdictPending || scoringEq}
          aria-invalid={from.trim() !== "" && !fromValid}
          aria-describedby="pf-from-hint"
          onChange={(e) => {
            setFrom(e.target.value);
            setVerdict(null);
            setVerdictError(null);
            setEq(null);
            setEqError(null);
          }}
          className="mt-1"
        />
        <p id="pf-from-hint" className="mt-1 text-xs text-muted-foreground">
          {from.trim() !== "" && !fromValid
            ? "Enter a complete email address, such as news@yourdomain.com."
            : senderDomainHint}
        </p>
        {senderDomainUnverified ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {fromDomain} is not a verified sending domain in this workspace, so
            the authentication half of both grades below will fail for a reason
            that is about the domain, not about this draft.
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="pf-verdict"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="pf-verdict" className="text-base font-medium">
          Pre-send verdict
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Grades the sender above together with the subject and HTML below.
        </p>
        <Button
          type="button"
          onClick={() => void runVerdict()}
          disabled={!canRunGradedChecks || !draftReady || verdictPending}
          loading={verdictPending}
          className="mt-3 min-h-11 sm:min-h-9"
        >
          {verdictPending ? "Running checks…" : "Run pre-send checks"}
        </Button>
        {gradedChecksBlocked ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {gradedChecksBlocked}
          </p>
        ) : draftReady ? null : (
          <p className="mt-2 text-sm text-muted-foreground">
            Fill in the sender address, a subject and the email HTML first —
            there is nothing to grade until all three are present.
          </p>
        )}
        <div aria-live="polite" aria-busy={verdictPending}>
          {verdictError ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {verdictError}
            </p>
          ) : null}
          {verdict ? (
            <>
              <p className="mt-3 text-sm font-medium">{verdict.verdict}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {verdict.summary}
              </p>

              {/* The combination a green badge would misrepresent. */}
              {passingButIncomplete(verdict) ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Nothing that ran objected — but the run was incomplete, so
                  this is not a clean bill of health. Treat it as &ldquo;no
                  known problem&rdquo;, not &ldquo;checked and safe&rdquo;.
                </p>
              ) : null}

              {stalled.length > 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {stalled.length} of {verdict.components.length} checks could
                  not run:{" "}
                  {stalled.map((c) => c.name.replace(/_/gu, " ")).join(", ")}.
                  Their absence is not a pass.
                </p>
              ) : null}

              <ul className="mt-3 divide-y rounded-lg border">
                {verdict.components.map((c) => (
                  <li
                    key={c.name}
                    className="flex flex-wrap items-baseline justify-between gap-2 p-3 text-sm"
                  >
                    <span>{c.name.replace(/_/gu, " ")}</span>
                    <span className="text-muted-foreground">
                      {c.status === "error"
                        ? (c.error ?? "did not run")
                        : `${c.status}${typeof c.score === "number" ? ` · ${c.score}` : ""}`}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Computed{" "}
                {formatWireTimestamp(
                  verdict.computed_at,
                  "at an unrecorded time",
                )}
                .
              </p>
            </>
          ) : null}
        </div>
      </section>

      <section
        aria-labelledby="pf-subject"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="pf-subject" className="text-base font-medium">
          Subject line
        </h2>
        <label htmlFor="pf-subject-input" className="mt-3 block text-sm">
          Subject
        </label>
        <Input
          id="pf-subject-input"
          value={subject}
          disabled={scoring || scoringEq || verdictPending}
          onChange={(e) => {
            setSubject(e.target.value);
            setScore(null);
            setScoreError(null);
            setEq(null);
            setEqError(null);
            setVerdict(null);
            setVerdictError(null);
          }}
          className="mt-1"
        />
        <Button
          type="button"
          onClick={runScore}
          disabled={scoring || subject.trim() === ""}
          loading={scoring}
          className="mt-3 min-h-11 sm:min-h-9"
        >
          {scoring ? "Scoring…" : "Score subject"}
        </Button>
        {/* Always mounted so the first result lands in a region that already
            exists — a live region introduced together with its content is not
            reliably announced. A failed scoring attempt is a routine outcome
            of this action, not an interruption, so it is polite too. */}
        <div aria-live="polite" aria-busy={scoring}>
          {scoreError ? (
            <p className="mt-2 text-sm text-destructive">{scoreError}</p>
          ) : null}
          {score ? (
            <>
              {/* 0 with no matched history is "no basis", not "zero percent". */}
              {expectationsUnfounded(score) ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  No past campaign resembles this subject line, so Moosewave has
                  no basis to expect an open or click rate for it. The
                  attributes below are measured; the expectations are not
                  available.
                </p>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">
                  Based on {score.matched_history.toLocaleString()} similar past{" "}
                  {score.matched_history === 1 ? "campaign" : "campaigns"}:{" "}
                  {(score.expected_open * 100).toFixed(1)}% expected opens,{" "}
                  {(score.expected_click * 100).toFixed(1)}% expected clicks.
                </p>
              )}
              <dl className="mt-3 grid gap-2 sm:grid-cols-3">
                {Object.entries(score.attributes).map(([k, val]) => (
                  <div key={k}>
                    <dt className="text-xs text-muted-foreground">
                      {k.replace(/_/gu, " ")}
                    </dt>
                    <dd className="text-sm tabular-nums">
                      {typeof val === "number"
                        ? Number.isInteger(val)
                          ? val
                          : val.toFixed(2)
                        : String(val)}
                    </dd>
                  </div>
                ))}
              </dl>
              {score.suggestions.length > 0 ? (
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {score.suggestions.map((s, index) => (
                    <li key={`${s}-${index}`}>{s}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
      </section>

      <section
        aria-labelledby="pf-a11y"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="pf-a11y" className="text-base font-medium">
          Accessibility
        </h2>
        <label htmlFor="pf-html" className="mt-3 block text-sm">
          Email HTML
        </label>
        <Textarea
          id="pf-html"
          value={html}
          disabled={checking || scoringEq || verdictPending}
          onChange={(e) => {
            setHtml(e.target.value);
            setReport(null);
            setA11yError(null);
            setEq(null);
            setEqError(null);
            setVerdict(null);
            setVerdictError(null);
          }}
          rows={4}
          className="mt-1 font-mono"
        />
        <Button
          type="button"
          onClick={runA11y}
          disabled={checking || html.trim() === ""}
          loading={checking}
          className="mt-3 min-h-11 sm:min-h-9"
        >
          {checking ? "Checking…" : "Check accessibility"}
        </Button>
        <div aria-live="polite" aria-busy={checking}>
          {a11yError ? (
            <p className="mt-2 text-sm text-destructive">{a11yError}</p>
          ) : null}
          {report ? (
            <>
              <p className="mt-3 text-sm text-muted-foreground">
                Score {report.score}.{" "}
                {report.findings.length === 0
                  ? "No issues found in the markup provided — this checks the HTML you pasted, not the rendered email."
                  : `${report.findings.length} issue(s).`}
              </p>
              {report.findings.length > 0 ? (
                <ul className="mt-3 divide-y rounded-lg border">
                  {report.findings.map((f, index) => (
                    <li key={`${f.rule}:${f.snippet}:${index}`} className="p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-sm font-medium">
                          {f.rule.replace(/_/gu, " ")}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {/* Not every rule maps to a WCAG criterion —
                              image_only does not — and a bare "WCAG" label
                              with nothing after it looks like a rendering
                              fault. */}
                          {f.severity}
                          {f.wcag ? ` · WCAG ${f.wcag}` : null}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {f.message}
                      </p>
                      <pre
                        tabIndex={0}
                        role="group"
                        aria-label={`${f.rule} snippet`}
                        className="mt-2 overflow-x-auto rounded-md border bg-muted/40 p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <code>{f.snippet}</code>
                      </pre>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
      </section>
      <section
        aria-labelledby="pf-email"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="pf-email" className="text-base font-medium">
          Address check
        </h2>
        <label htmlFor="pf-addr" className="mt-3 block text-sm">
          Email address
        </label>
        <Input
          id="pf-addr"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={addr}
          disabled={checkingEmail}
          aria-invalid={addr.trim() !== "" && !addressValid}
          aria-describedby="pf-addr-hint"
          onChange={(e) => {
            setAddr(e.target.value);
            setEmailVerdict(null);
            setEmailError(null);
          }}
          className="mt-1"
        />
        <p id="pf-addr-hint" className="mt-1 text-xs text-muted-foreground">
          {addr.trim() !== "" && !addressValid
            ? "Enter a complete email address, such as name@example.com."
            : "Syntax, MX, disposable-domain, and role-address checks."}
        </p>
        <Button
          type="button"
          disabled={checkingEmail || !addressValid}
          onClick={() => void runEmailCheck()}
          loading={checkingEmail}
          className="mt-3 min-h-11 sm:min-h-9"
        >
          {checkingEmail ? "Checking…" : "Check address"}
        </Button>
        <div aria-live="polite" aria-busy={checkingEmail}>
          {emailError ? (
            <p className="mt-2 text-sm text-destructive">{emailError}</p>
          ) : null}
          {emailVerdict ? (
            <>
              <p className="mt-3 text-sm text-muted-foreground">
                {emailVerdict.verdict.replace(/_/gu, " ")}
                {emailVerdict.has_mx
                  ? " · domain accepts mail"
                  : " · no MX record"}
              </p>
              {/* valid and verdict are different questions. */}
              {deliverableButUnwise(emailVerdict) ? (
                <p className="mt-2 text-sm font-medium">
                  This address is deliverable, but{" "}
                  {emailVerdict.role_account
                    ? "it is a shared role account nobody personally owns — poor engagement, and a common route into a spam trap."
                    : "it is a disposable address that will stop existing."}{" "}
                  Deliverable is not the same as worth adding.
                </p>
              ) : emailVerdict.valid ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  No problems found with this address.
                </p>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  Not deliverable
                  {emailVerdict.reasons.length > 0
                    ? `: ${emailVerdict.reasons.join("; ")}`
                    : "."}
                </p>
              )}
            </>
          ) : null}
        </div>
      </section>
      <section aria-labelledby="pf-eq" className="rounded-lg border p-4 sm:p-6">
        <h2 id="pf-eq" className="text-base font-medium">
          Deliverability score
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Grades the sender address, subject and HTML on this page, and keeps
          the result in this workspace&rsquo;s score history.
        </p>
        <Button
          type="button"
          disabled={!canRunGradedChecks || !draftReady || scoringEq}
          onClick={() => void runEqScore()}
          loading={scoringEq}
          className="mt-3 min-h-11 sm:min-h-9"
        >
          {scoringEq ? "Scoring…" : "Score this send"}
        </Button>
        {gradedChecksBlocked ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {gradedChecksBlocked}
          </p>
        ) : draftReady ? null : (
          <p className="mt-2 text-sm text-muted-foreground">
            Fill in the sender address, a subject and the email HTML first — a
            score over a stand-in value would be recorded as a real one.
          </p>
        )}
        <div aria-live="polite" aria-busy={scoringEq}>
          {eqError ? (
            <p className="mt-2 text-sm text-destructive">{eqError}</p>
          ) : null}
          {eq ? (
            <>
              <p className="mt-3 text-sm font-medium">
                {eq.score} · grade {eq.grade}
              </p>
              {/* A lone grade sends someone rewriting copy that was never the
                  problem. Name the half that actually failed. */}
              {weakestComponent(eq) === "auth" ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Your content scores {eq.content.score}. The grade is held down
                  by sender authentication ({eq.auth.score}) — this is a DNS and
                  domain-verification problem, not a writing one.
                </p>
              ) : weakestComponent(eq) === "content" ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Authentication scores {eq.auth.score}. The grade is held down
                  by the content ({eq.content.score}).
                </p>
              ) : null}
              <ul className="mt-3 space-y-2">
                {[...eq.auth.reasons, ...eq.content.reasons].map((r, index) => (
                  <li
                    key={`${r.code}-${index}`}
                    className="text-sm text-muted-foreground"
                  >
                    <span className="font-medium">{r.severity}</span> —{" "}
                    {r.message}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </section>
      <PreflightAdvancedChecks identity={meQuery.data ?? null} subject={subject} />
    </PageShell>
  );
}
