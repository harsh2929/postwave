// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { EmailPreview } from "@/components/campaigns/email-preview";
import { PageShell } from "@/components/dashboard/page-shell";
import { LineChart } from "@/components/charts/line-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { setAiCampaignHandoff } from "@/lib/ai-campaign-handoff";
import {
  AI_UNAVAILABLE_MESSAGE,
  askAnalytics,
  checkVoiceDrift,
  composeBroadcast,
  composeVariants,
  generateSubjectLines,
  getAnomalyBrief,
  getTopPerformingSubjects,
  scoreSubjectLines,
  type AiOutcome,
  type AnalyticsAnswer,
  type AnomalyBriefResult,
  type AnomalyMetric,
  type ComposedBroadcast,
  type GeneratedSubjectLines,
  type SubjectLineScores,
  type VoiceDriftReading,
} from "@/lib/ai-compose-api";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { canWriteCampaigns } from "@/lib/campaign-write-authority";
import { formatCents } from "@/lib/format-currency";
import { base, qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import { roleCanWrite } from "@/lib/use-admin-gate";

type ActionKey =
  | "compose"
  | "variants"
  | "subjects"
  | "scores"
  | "analytics"
  | "anomaly"
  | "voice";

function ActionError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
    >
      {message}
    </p>
  );
}

function ResultMeta({ generatedAt }: { generatedAt: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Generated {new Date(generatedAt).toLocaleString()}. Review AI output
      before publishing or sending.
    </p>
  );
}

function subjectSet(values: string[]): string[] {
  return Array.from(
    new Map(
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => [value.toLocaleLowerCase(), value]),
    ).values(),
  ).slice(0, 8);
}

function formatCell(value: string | number | boolean | null): string {
  if (value === null) return "—";
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value;
}

function humanize(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export default function AiAssistPage() {
  const router = useRouter();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState<ActionKey | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ActionKey, string>>>({});

  const [brief, setBrief] = useState("Monthly developer tooling newsletter");
  const [tone, setTone] = useState("");
  const [audience, setAudience] = useState("");
  const [draft, setDraft] = useState<ComposedBroadcast | null>(null);
  const [activeSubject, setActiveSubject] = useState("");

  const [subjectPrompt, setSubjectPrompt] = useState(
    "Monthly developer tooling newsletter",
  );
  const [subjectTone, setSubjectTone] = useState("");
  const [subjectAudience, setSubjectAudience] = useState("");
  const [subjects, setSubjects] = useState<GeneratedSubjectLines | null>(null);
  const [scores, setScores] = useState<SubjectLineScores | null>(null);

  const [question, setQuestion] = useState(
    "How many subscribers joined last week?",
  );
  const [answer, setAnswer] = useState<AnalyticsAnswer | null>(null);

  const [anomalyMetric, setAnomalyMetric] = useState<AnomalyMetric>("opens");
  const [anomalyWindow, setAnomalyWindow] = useState(7);
  const [anomalyContext, setAnomalyContext] = useState("");
  const [anomaly, setAnomaly] = useState<AnomalyBriefResult | null>(null);

  const [voiceText, setVoiceText] = useState(
    "Monthly developer tooling newsletter",
  );
  const [voice, setVoice] = useState<VoiceDriftReading | null>(null);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const role = identity ? effectiveAuthRole(identity) : null;
  // The server splits these endpoints two ways: compose/broadcast,
  // compose/variants, subject-lab/score and voice/drift accept an editor,
  // while ai/subject-lines/generate is admin-only. One owner|admin gate
  // over both told editors they held a qualifying role and then disabled
  // every control on the page. canWriteCampaigns also refuses viewer mode
  // outright, which matters because effective_role may be absent from the
  // whoami payload while viewer_mode is set.
  const viewerMode = identity?.viewer_mode === true;
  const canCompose = canWriteCampaigns(identity);
  const canGenerateSubjects = !viewerMode && roleCanWrite(role);
  const composeDeniedReason = viewerMode
    ? "This session is in viewer mode, so AI drafting is refused."
    : "Drafting with AI requires an editor, admin, or owner role.";
  const subjectsDeniedReason = viewerMode
    ? "This session is in viewer mode, so subject generation is refused."
    : "Generating subject lines requires an admin or owner role.";
  const topSubjectsKey = useMemo(
    () =>
      [
        ...base(
          "ai-subject-top-performers",
          meQuery.data?.tenant_id ?? "anon",
          role,
        ),
        90,
        20,
      ] as const,
    [meQuery.data?.tenant_id, role],
  );
  const topSubjects = useQuery({
    queryKey: topSubjectsKey,
    queryFn: ({ signal }) =>
      getTopPerformingSubjects({
        days: 90,
        limit: 8,
        minRecipients: 20,
        signal,
      }),
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });

  function setActionError(key: ActionKey, message?: string) {
    setErrors((current) => ({ ...current, [key]: message }));
  }

  async function runOutcome<T>(
    key: ActionKey,
    operation: () => Promise<AiOutcome<T>>,
    onSuccess: (value: T) => void,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    setActionError(key);
    try {
      const result = await operation();
      if (!result.ok) {
        setActionError(key, AI_UNAVAILABLE_MESSAGE);
        return;
      }
      onSuccess(result.value);
    } catch (error) {
      setActionError(
        key,
        apiErrorMessage(error, "The AI operation could not be completed."),
      );
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function runValue<T>(
    key: ActionKey,
    operation: () => Promise<T>,
    onSuccess: (value: T) => void,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    setActionError(key);
    try {
      onSuccess(await operation());
    } catch (error) {
      setActionError(
        key,
        apiErrorMessage(error, "The operation could not be completed."),
      );
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function copyText(value: string, label: string) {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable in this browser.");
      }
      await navigator.clipboard.writeText(value);
      toast.success(label + " copied");
    } catch (error) {
      toast.error(apiErrorMessage(error, "Could not copy to the clipboard."));
    }
  }

  function handoffDraft(
    mode: "draft" | "ab_test",
    input: {
      name?: string;
      subject: string;
      bodyHtml?: string;
      previewText?: string;
      variants?: string[];
    },
  ) {
    try {
      setAiCampaignHandoff({
        mode,
        subject: input.subject,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.bodyHtml === undefined ? {} : { bodyHtml: input.bodyHtml }),
        ...(input.previewText === undefined
          ? {}
          : { previewText: input.previewText }),
        ...(input.variants === undefined
          ? {}
          : { subjectVariants: input.variants }),
      });
      router.push(asRoute("/app/campaigns?create=1"));
    } catch (error) {
      toast.error(apiErrorMessage(error, "Could not prepare the campaign."));
    }
  }

  const draftSubjects = draft?.subjectVariants ?? [];
  const activeDraftSubject =
    draftSubjects.includes(activeSubject) && activeSubject
      ? activeSubject
      : (draft?.primary?.subject ?? "");
  const scoredBySubject = new Map(
    (scores?.variants ?? []).map((score) => [
      score.text.toLocaleLowerCase(),
      score,
    ]),
  );
  const voiceInactive =
    voice?.severity === "ok" &&
    (voice.suggestions ?? []).some((suggestion) =>
      /drift check is inactive|no voice profile/iu.test(suggestion),
    );

  return (
    <PageShell className="max-w-6xl">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            AI assist
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Generate, inspect, compare, copy, and hand off review-ready drafts.
            Nothing is sent automatically.
          </p>
        </div>
        <Button asChild variant="outline" className="h-11 sm:h-9">
          <Link href={asRoute("/app/ai-assist/chat")}>Open Moosewave AI chat</Link>
        </Button>
      </header>

      {meQuery.isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : meQuery.isError ? (
        <div
          role="alert"
          className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-emphasis"
        >
          <p>
            Workspace identity could not be verified. AI requests have not been
            enabled.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void meQuery.refetch()}
            loading={meQuery.isFetching}
          >
            Retry identity
          </Button>
        </div>
      ) : !canCompose ? (
        <div role="note" className="rounded-md border p-4 text-sm">
          {viewerMode
            ? "This session is acting in viewer mode. Analytics answers and historical subject examples remain available, but every AI operation that drafts campaign copy is refused until you leave viewer mode."
            : "You have read-only access. Analytics answers and historical subject examples remain available, but campaign-writing AI operations require an editor, admin, or owner role."}
        </div>
      ) : !canGenerateSubjects ? (
        <div role="note" className="rounded-md border p-4 text-sm">
          Subject line generation requires an admin or owner role. Drafting,
          variants, analytics and voice drift are available to your{" "}
          {role ?? "current"} role.
        </div>
      ) : null}

      <Tabs defaultValue="compose">
        <TabsList aria-label="AI assist workspaces">
          <TabsTrigger value="compose">Compose</TabsTrigger>
          <TabsTrigger value="subjects">Subject lab</TabsTrigger>
          <TabsTrigger value="analytics">Ask analytics</TabsTrigger>
          <TabsTrigger value="anomalies">Anomaly brief</TabsTrigger>
          <TabsTrigger value="voice">Voice drift</TabsTrigger>
        </TabsList>

        <TabsContent value="compose" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Compose a broadcast</CardTitle>
              <CardDescription>
                A bounded brief produces a complete draft and subject options.
                Output remains in this page until you explicitly copy or hand it
                to Campaigns.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ai-compose-brief">Brief</Label>
                <Textarea
                  id="ai-compose-brief"
                  value={brief}
                  maxLength={4_000}
                  onChange={(event) => setBrief(event.target.value)}
                  disabled={busy !== null}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="ai-compose-tone">Tone override</Label>
                  <Input
                    id="ai-compose-tone"
                    value={tone}
                    maxLength={100}
                    placeholder="Use active brand voice"
                    onChange={(event) => setTone(event.target.value)}
                    disabled={busy !== null}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ai-compose-audience">Audience context</Label>
                  <Input
                    id="ai-compose-audience"
                    value={audience}
                    maxLength={500}
                    placeholder="Paid annual subscribers"
                    onChange={(event) => setAudience(event.target.value)}
                    disabled={busy !== null}
                  />
                </div>
              </div>
              <Button
                type="button"
                disabled={
                  !canCompose || busy !== null || brief.trim().length < 3
                }
                title={canCompose ? undefined : composeDeniedReason}
                loading={busy === "compose"}
                onClick={() =>
                  void runOutcome(
                    "compose",
                    () =>
                      composeBroadcast(brief, {
                        tone,
                        audience,
                        variantCount: 2,
                      }),
                    (result) => {
                      setDraft(result);
                      setActiveSubject(result.primary.subject);
                    },
                  )
                }
              >
                Generate broadcast
              </Button>
              <ActionError message={errors.compose} />
            </CardContent>
          </Card>

          {draft ? (
            <Card aria-live="polite">
              <CardHeader>
                <CardTitle>{draft.primary.name}</CardTitle>
                <CardDescription>
                  Select a subject, review the rendered body, then choose an
                  explicit handoff.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">
                    Subject options
                  </legend>
                  <div className="flex flex-wrap gap-2">
                    {draft.subjectVariants.map((subject) => (
                      <Button
                        key={subject}
                        type="button"
                        variant={
                          activeDraftSubject === subject ? "default" : "outline"
                        }
                        aria-pressed={activeDraftSubject === subject}
                        onClick={() => setActiveSubject(subject)}
                      >
                        {subject}
                      </Button>
                    ))}
                  </div>
                </fieldset>
                {draft.primary.preview_text ? (
                  <p className="rounded-md border bg-muted/20 p-3 text-sm">
                    <span className="font-medium">Preview text:</span>{" "}
                    {draft.primary.preview_text}
                  </p>
                ) : null}
                <EmailPreview html={draft.primary.body} />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      busy !== null || draft.subjectVariants.length >= 5
                    }
                    loading={busy === "variants"}
                    onClick={() =>
                      void runOutcome(
                        "variants",
                        () =>
                          composeVariants(
                            activeDraftSubject,
                            draft.primary.body,
                            3,
                          ),
                        (result) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  subjectVariants: subjectSet([
                                    ...current.subjectVariants,
                                    ...result.subjectVariants,
                                  ]).slice(0, 5),
                                }
                              : current,
                          ),
                      )
                    }
                  >
                    More subject variants
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void copyText(
                        activeDraftSubject +
                          "\n\n" +
                          (draft.primary.preview_text
                            ? draft.primary.preview_text + "\n\n"
                            : "") +
                          draft.primary.body,
                        "Broadcast draft",
                      )
                    }
                  >
                    Copy draft
                  </Button>
                  <Button
                    type="button"
                    onClick={() =>
                      handoffDraft("draft", {
                        name: draft.primary.name,
                        subject: activeDraftSubject,
                        bodyHtml: draft.primary.body,
                        previewText: draft.primary.preview_text,
                        variants: draft.subjectVariants,
                      })
                    }
                  >
                    Use as campaign draft
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={draft.subjectVariants.length < 2}
                    onClick={() =>
                      handoffDraft("ab_test", {
                        name: draft.primary.name,
                        subject: activeDraftSubject,
                        bodyHtml: draft.primary.body,
                        previewText: draft.primary.preview_text,
                        variants: draft.subjectVariants,
                      })
                    }
                  >
                    Prepare A/B test
                  </Button>
                </div>
                <ActionError message={errors.variants} />
                <ResultMeta generatedAt={draft.generatedAt} />
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="subjects" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Subject lab</CardTitle>
              <CardDescription>
                Generate one to five candidates, score them against the
                workspace&apos;s historical corpus, then choose a campaign or
                A/B handoff.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ai-subject-prompt">Subject brief</Label>
                <Textarea
                  id="ai-subject-prompt"
                  value={subjectPrompt}
                  maxLength={2_048}
                  onChange={(event) => setSubjectPrompt(event.target.value)}
                  disabled={busy !== null}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="ai-subject-tone">Tone override</Label>
                  <Input
                    id="ai-subject-tone"
                    value={subjectTone}
                    maxLength={100}
                    onChange={(event) => setSubjectTone(event.target.value)}
                    disabled={busy !== null}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ai-subject-audience">Target audience</Label>
                  <Input
                    id="ai-subject-audience"
                    value={subjectAudience}
                    maxLength={500}
                    onChange={(event) => setSubjectAudience(event.target.value)}
                    disabled={busy !== null}
                  />
                </div>
              </div>
              <Button
                type="button"
                disabled={
                  !canGenerateSubjects ||
                  busy !== null ||
                  subjectPrompt.trim().length < 3
                }
                title={canGenerateSubjects ? undefined : subjectsDeniedReason}
                loading={busy === "subjects"}
                onClick={() =>
                  void runOutcome(
                    "subjects",
                    () =>
                      generateSubjectLines(subjectPrompt, {
                        tone: subjectTone,
                        targetAudience: subjectAudience,
                        variantCount: 5,
                      }),
                    (result) => {
                      setSubjects(result);
                      setScores(null);
                    },
                  )
                }
              >
                Generate subjects
              </Button>
              <ActionError message={errors.subjects} />
            </CardContent>
          </Card>

          {subjects ? (
            <Card aria-live="polite">
              <CardHeader>
                <CardTitle>Generated candidates</CardTitle>
                <CardDescription>
                  {subjects.fallback
                    ? "The provider returned fewer distinct candidates than requested; placeholders were backfilled and require extra review."
                    : "Distinct candidates returned by the subject assistant."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <ul className="space-y-3">
                  {subjects.candidates.map((subject) => {
                    const score = scoredBySubject.get(
                      subject.toLocaleLowerCase(),
                    );
                    return (
                      <li
                        key={subject}
                        className="rounded-md border bg-muted/10 p-3"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="font-medium">{subject}</p>
                            {score ? (
                              <p className="mt-1 text-xs text-muted-foreground">
                                Predicted open{" "}
                                {(score.predictedOpen * 100).toFixed(1)}% · 90%
                                interval {(score.ciLow * 100).toFixed(1)}–
                                {(score.ciHigh * 100).toFixed(1)}% ·{" "}
                                {score.matchedCount.toLocaleString()} matched
                                campaigns
                                {score.lowConfidence ? " · low confidence" : ""}
                                {score.belowBaseline ? " · below baseline" : ""}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => void copyText(subject, "Subject")}
                            >
                              Copy
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => handoffDraft("draft", { subject })}
                            >
                              Use in campaign
                            </Button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy !== null}
                    loading={busy === "scores"}
                    onClick={() =>
                      void runValue(
                        "scores",
                        () => scoreSubjectLines(subjects.candidates),
                        setScores,
                      )
                    }
                  >
                    Score candidates
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={subjects.candidates.length < 2}
                    onClick={() =>
                      handoffDraft("ab_test", {
                        subject: subjects.candidates[0] ?? "",
                        variants: subjects.candidates,
                      })
                    }
                  >
                    Prepare A/B test
                  </Button>
                </div>
                <ActionError message={errors.scores} />
                {scores ? (
                  <p className="text-xs text-muted-foreground">
                    Historical baseline:{" "}
                    {(scores.baselineOpen * 100).toFixed(1)}% across the last{" "}
                    {scores.windowDays} days. Predictions are evidence, not a
                    guarantee.
                  </p>
                ) : null}
                <ResultMeta generatedAt={subjects.generatedAt} />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Top historical subjects</CardTitle>
              <CardDescription>
                Sent campaigns from the last 90 days with at least 20
                recipients. Tiny tests are excluded.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {topSubjects.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : topSubjects.isError ? (
                <div className="space-y-3">
                  <ActionError message="Historical subject performance could not be verified." />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void topSubjects.refetch()}
                    loading={topSubjects.isFetching}
                  >
                    Retry history
                  </Button>
                </div>
              ) : (topSubjects.data?.top?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No qualifying sent campaigns were found.
                </p>
              ) : (
                <TableContainer aria-label="Top historical campaign subjects">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Subject</TableHead>
                        <TableHead className="text-right">Recipients</TableHead>
                        <TableHead className="text-right">Open rate</TableHead>
                        <TableHead className="text-right">Click rate</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {topSubjects.data?.top?.map((item) => (
                        <TableRow key={item.campaignId}>
                          <TableCell>
                            <p className="font-medium">{item.subject}</p>
                            <p className="text-xs text-muted-foreground">
                              {item.name}
                            </p>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {item.recipients.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {(item.openRate * 100).toFixed(1)}%
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {(item.clickRate * 100).toFixed(1)}%
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="analytics" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Ask analytics</CardTitle>
              <CardDescription>
                Natural language selects one server-whitelisted report template.
                The model cannot author SQL.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ai-analytics-question">Question</Label>
                <Textarea
                  id="ai-analytics-question"
                  value={question}
                  maxLength={1_000}
                  onChange={(event) => setQuestion(event.target.value)}
                  disabled={busy !== null}
                />
              </div>
              <Button
                type="button"
                disabled={
                  !meQuery.isSuccess || busy !== null || !question.trim()
                }
                loading={busy === "analytics"}
                onClick={() =>
                  void runOutcome(
                    "analytics",
                    () => askAnalytics(question),
                    setAnswer,
                  )
                }
              >
                Ask analytics
              </Button>
              <ActionError message={errors.analytics} />
              {answer ? (
                <div className="space-y-4" aria-live="polite">
                  <p className="rounded-md border bg-muted/20 p-3 text-sm">
                    {answer.summaryText || "The report returned no summary."}
                  </p>
                  {answer.rows.length > 0 && answer.columns.length > 0 ? (
                    <TableContainer aria-label="Analytics answer data">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {answer.columns.map((column) => (
                              <TableHead key={column}>
                                {humanize(column)}
                              </TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {answer.rows.map((row, index) => (
                            <TableRow key={String(index)}>
                              {answer.columns.map((column) => (
                                <TableCell
                                  key={column}
                                  className="max-w-80 break-words"
                                >
                                  {formatCell(row[column] ?? null)}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      The selected report returned no rows.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Whitelisted template: {humanize(answer.template)} ·
                    generated {new Date(answer.generatedAt).toLocaleString()}.
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="anomalies" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Anomaly brief</CardTitle>
              <CardDescription>
                Compare a measured metric with its prior window and review the
                model&apos;s explanation alongside the exact aggregates.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="ai-anomaly-metric">Metric</Label>
                  <Select
                    id="ai-anomaly-metric"
                    value={anomalyMetric}
                    onChange={(event) =>
                      setAnomalyMetric(event.target.value as AnomalyMetric)
                    }
                    disabled={busy !== null}
                  >
                    <option value="opens">Opens</option>
                    <option value="clicks">Clicks</option>
                    <option value="bounces">Bounces</option>
                    <option value="complaints">Complaints</option>
                    <option value="unsubscribes">Unsubscribes</option>
                    <option value="revenue">Revenue</option>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ai-anomaly-window">Window</Label>
                  <Select
                    id="ai-anomaly-window"
                    value={String(anomalyWindow)}
                    onChange={(event) =>
                      setAnomalyWindow(Number(event.target.value))
                    }
                    disabled={busy !== null}
                  >
                    <option value="7">7 days</option>
                    <option value="30">30 days</option>
                    <option value="90">90 days</option>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ai-anomaly-context">Optional context</Label>
                <Textarea
                  id="ai-anomaly-context"
                  value={anomalyContext}
                  maxLength={4_000}
                  onChange={(event) => setAnomalyContext(event.target.value)}
                  disabled={busy !== null}
                />
              </div>
              <Button
                type="button"
                disabled={!meQuery.isSuccess || busy !== null}
                loading={busy === "anomaly"}
                onClick={() =>
                  void runOutcome(
                    "anomaly",
                    () =>
                      getAnomalyBrief({
                        metric: anomalyMetric,
                        windowDays: anomalyWindow,
                        context: anomalyContext,
                      }),
                    setAnomaly,
                  )
                }
              >
                Generate anomaly brief
              </Button>
              <ActionError message={errors.anomaly} />
              {anomaly ? (
                <div className="space-y-5" aria-live="polite">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md border bg-muted/20 p-3">
                      <p className="text-xs text-muted-foreground">
                        Current {anomaly.windowDays} days
                      </p>
                      <p className="text-xl font-semibold tabular-nums">
                        {anomaly.metric === "revenue" &&
                        anomaly.revenueScope?.currency
                          ? formatCents(
                              anomaly.currentTotal,
                              anomaly.revenueScope.currency,
                            )
                          : anomaly.currentTotal.toLocaleString()}
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/20 p-3">
                      <p className="text-xs text-muted-foreground">
                        Previous {anomaly.windowDays} days
                      </p>
                      <p className="text-xl font-semibold tabular-nums">
                        {anomaly.metric === "revenue" &&
                        anomaly.revenueScope?.currency
                          ? formatCents(
                              anomaly.previousTotal,
                              anomaly.revenueScope.currency,
                            )
                          : anomaly.previousTotal.toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <p className="rounded-md border p-3 text-sm">
                    {anomaly.summary}
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <h3 className="text-sm font-medium">Probable causes</h3>
                      {anomaly.probableCauses.length > 0 ? (
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                          {anomaly.probableCauses.map((cause) => (
                            <li key={cause}>{cause}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-sm text-muted-foreground">
                          No probable causes were returned.
                        </p>
                      )}
                    </div>
                    <div>
                      <h3 className="text-sm font-medium">Suggested actions</h3>
                      {anomaly.suggestedActions.length > 0 ? (
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                          {anomaly.suggestedActions.map((action) => (
                            <li key={action}>{action}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-sm text-muted-foreground">
                          No actions were returned.
                        </p>
                      )}
                    </div>
                  </div>
                  {anomaly.daily.length >= 2 ? (
                    <LineChart
                      values={anomaly.daily.map((point) => point.value)}
                      labels={anomaly.daily.map((point) => point.day)}
                      ariaLabel={humanize(anomaly.metric) + " by day"}
                      formatY={
                        anomaly.metric === "revenue" &&
                        anomaly.revenueScope?.currency
                          ? (value) =>
                              formatCents(
                                Math.round(value),
                                anomaly.revenueScope?.currency ?? "USD",
                              )
                          : undefined
                      }
                    />
                  ) : null}
                  {anomaly.revenueScope?.excludedCurrencyCount ? (
                    <p className="text-xs text-warning-emphasis">
                      {anomaly.revenueScope.excludedCurrencyCount} other
                      currency bucket(s) were excluded from the dominant
                      currency aggregate.
                    </p>
                  ) : null}
                  <ResultMeta generatedAt={anomaly.generatedAt} />
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="voice" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Voice drift</CardTitle>
              <CardDescription>
                Compare draft text with the active workspace voice profile. This
                is advisory and never sends or blocks a campaign.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ai-voice-text">Draft text</Label>
                <Textarea
                  id="ai-voice-text"
                  value={voiceText}
                  maxLength={200_000}
                  className="min-h-40"
                  onChange={(event) => setVoiceText(event.target.value)}
                  disabled={busy !== null}
                />
              </div>
              <Button
                type="button"
                disabled={!canCompose || busy !== null || !voiceText.trim()}
                title={canCompose ? undefined : composeDeniedReason}
                loading={busy === "voice"}
                onClick={() =>
                  void runOutcome(
                    "voice",
                    () => checkVoiceDrift(voiceText),
                    setVoice,
                  )
                }
              >
                Check voice drift
              </Button>
              <ActionError message={errors.voice} />
              {voice ? (
                <div className="space-y-4" aria-live="polite">
                  <div className="flex flex-wrap items-center gap-3 rounded-md border p-4">
                    <span className="text-3xl font-semibold tabular-nums">
                      {voice.score.toFixed(0)}
                    </span>
                    <span className="text-sm text-muted-foreground">/ 100</span>
                    <Badge
                      variant={
                        voiceInactive
                          ? "outline"
                          : voice.severity === "ok"
                            ? "success"
                            : voice.severity === "warn"
                              ? "warning"
                              : "destructive"
                      }
                    >
                      {voiceInactive ? "inactive" : voice.severity}
                    </Badge>
                  </div>
                  {voiceInactive ? (
                    <p role="note" className="text-sm text-muted-foreground">
                      No active voice profile was available, so this score is a
                      no-op result rather than evidence that the draft is on
                      brand.
                    </p>
                  ) : null}
                  {voice.reason ? (
                    <p className="text-sm">{voice.reason}</p>
                  ) : null}
                  {voice.profileId || voice.authoredAdjustment !== undefined ? (
                    <p className="text-xs text-muted-foreground">
                      {voice.profileId
                        ? "Voice profile " + voice.profileId
                        : "Active voice profile"}
                      {voice.authoredAdjustment !== undefined
                        ? " · authored-rule adjustment " +
                          (voice.authoredAdjustment >= 0 ? "+" : "") +
                          voice.authoredAdjustment.toFixed(1)
                        : ""}
                    </p>
                  ) : null}
                  {voice.components ? (
                    <dl className="grid gap-3 sm:grid-cols-3">
                      {Object.entries(voice.components).map(([name, value]) => (
                        <div
                          key={name}
                          className="rounded-md border bg-muted/20 p-3"
                        >
                          <dt className="text-xs text-muted-foreground">
                            {humanize(name)}
                          </dt>
                          <dd className="font-semibold tabular-nums">
                            {value.toFixed(1)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {(voice.suggestions?.length ?? 0) > 0 ? (
                    <div>
                      <h3 className="text-sm font-medium">Suggestions</h3>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                        {voice.suggestions?.map((suggestion) => (
                          <li key={suggestion}>{suggestion}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
