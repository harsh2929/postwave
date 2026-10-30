// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Eraser,
  RotateCw,
  Sparkles,
  SquarePen,
} from "lucide-react";
import { toast } from "sonner";

import { CrossClientPreview } from "@/components/editor/cross-client-preview";
import { PlacementBar } from "@/components/inbox-reality/placement-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/dashboard/page-shell";
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
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { whoami } from "@/lib/auth-api";
import {
  CAMPAIGN_READ_ONLY_MESSAGE,
  canWriteCampaigns,
} from "@/lib/campaign-write-authority";
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  type Campaign,
} from "@/lib/campaigns-api";
import { STALE, qk } from "@/lib/query-keys";
import {
  assessSubject,
  extractLinks,
  looksLikeHtml,
  riskBand,
  riskFactorRows,
  type RiskBand,
} from "@/lib/inbox-reality-helpers";
import { getAuthChecks, getReputation, predict } from "@/lib/inbox-reality-api";
import type { PredictResponse } from "@/lib/inbox-reality-types";

const EXAMPLE_SUBJECT = "Your April edit is here — 5 stories inside";
const EXAMPLE_HTML = `<html>
  <body style="font-family: -apple-system, Segoe UI, sans-serif; color:#1a1a1a;">
    <h1 style="font-size:22px;">The April Edit</h1>
    <p>Hi there — here are the five things worth your time this month.</p>
    <ul>
      <li><a href="https://example.com/story-1">The interview everyone's quoting</a></li>
      <li><a href="https://example.com/story-2">A field guide to shipping faster</a></li>
    </ul>
    <p>Thanks for reading.<br/>— The team</p>
    <p style="font-size:12px;color:#888;">
      <a href="https://example.com/unsubscribe">Unsubscribe</a>
    </p>
  </body>
</html>`;

const RISK_BAND_BAR: Record<RiskBand, string> = {
  low: "bg-success",
  medium: "bg-warning",
  high: "bg-destructive",
};
const RISK_BAND_BADGE: Record<RiskBand, "success" | "warning" | "destructive"> =
  {
    low: "success",
    medium: "warning",
    high: "destructive",
  };

const TONE_CLASS: Record<"ok" | "neutral" | "warn", string> = {
  ok: "text-success",
  neutral: "text-muted-foreground",
  warn: "text-warning-emphasis",
};

export default function PredictPage() {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const [result, setResult] = useState<PredictResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Forecasting is readable by anyone, but the forward action creates a
  // campaign, so it has to answer to the same authority the campaigns surface
  // uses. canWriteCampaigns reads the effective role and refuses viewer mode,
  // which the raw role field alone would let through.
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const canCreateCampaign = canWriteCampaigns(meQuery.data);

  // "Load from campaign" picker (INBOX-025). Its loading, empty, and failed
  // states remain distinct so an API failure never reads as no campaigns.
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignListLoading, setCampaignListLoading] = useState(true);
  const [campaignListError, setCampaignListError] = useState(false);
  const [campaignListReloadKey, setCampaignListReloadKey] = useState(0);
  const [campaignDraftError, setCampaignDraftError] = useState<string | null>(
    null,
  );
  const [loadingCampaign, setLoadingCampaign] = useState(false);

  useEffect(() => {
    setHydrated(true);
    let cancelled = false;
    listCampaigns({ limit: 50 })
      .then((list) => {
        if (!cancelled) {
          setCampaigns(list);
          setCampaignListError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setCampaignListError(true);
      })
      .finally(() => {
        if (!cancelled) setCampaignListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [campaignListReloadKey]);

  const run = useCallback(async () => {
    if (!html && !subject) return;
    setRunning(true);
    setError(null);
    try {
      const [reputation, authChecks] = await Promise.all([
        getReputation(),
        getAuthChecks(),
      ]);
      const auth = authChecks[0];
      if (!auth)
        throw new Error("No sender authentication check is available.");
      const r = await predict({
        subject,
        html,
        links: extractLinks(html),
        reputation,
        auth,
      });
      setResult(r);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Persist the failure inline (a toast is transient and would leave the
      // Forecast card looking pristine/empty) — INBOX-002.
      setError(message);
      toast.error("Prediction failed", { description: message });
    } finally {
      setRunning(false);
    }
  }, [html, subject]);

  const loadExample = useCallback(() => {
    setSubject(EXAMPLE_SUBJECT);
    setHtml(EXAMPLE_HTML);
    setResult(null);
    setError(null);
    setCampaignDraftError(null);
  }, []);

  const clearAll = useCallback(() => {
    setSubject("");
    setHtml("");
    setResult(null);
    setError(null);
    setCampaignDraftError(null);
  }, []);

  const loadFromCampaign = useCallback(async (id: string) => {
    if (!id) return;
    setLoadingCampaign(true);
    setCampaignDraftError(null);
    setResult(null);
    setError(null);
    try {
      const c = await getCampaign(id);
      setSubject(c.subject ?? "");
      setHtml(c.body_html ?? "");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setCampaignDraftError(message);
      toast.error("Could not load campaign", { description: message });
    } finally {
      setLoadingCampaign(false);
    }
  }, []);

  const createFromDraft = useCallback(async () => {
    if (!canCreateCampaign || creating) return;
    setCreating(true);
    try {
      const created = await createCampaign({
        name: subject.trim() || "Draft from Inbox Reality predictor",
        subject: subject.trim() || "Untitled",
        editor_mode: "html",
        body_html: html,
      });
      router.push(`/app/campaigns/${created.id}`);
    } catch (err: unknown) {
      toast.error("Could not create campaign", {
        description: err instanceof Error ? err.message : String(err),
      });
      setCreating(false);
    }
  }, [canCreateCampaign, creating, subject, html, router]);

  // Cmd/Ctrl+Enter submits from either field (INBOX-037).
  const onFormKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void run();
    }
  };

  const subjectHint = assessSubject(subject);
  const bodyIsHtml = html.length === 0 || looksLikeHtml(html);
  const linkCount = extractLinks(html).length;
  const disabledReason =
    !html && !subject
      ? "Enter a subject or HTML body to run a prediction."
      : "";
  const cleanDraft =
    result != null &&
    (result.content.spam_reasons?.length ?? 0) === 0 &&
    (result.content.html_issues?.length ?? 0) === 0;
  const createDeniedReason = !meQuery.isFetched
    ? "Checking campaign access…"
    : canCreateCampaign
      ? null
      : CAMPAIGN_READ_ONLY_MESSAGE;

  return (
    <PageShell className="[&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <div>
        <Link
          href="/app/inbox-reality"
          className="inline-flex min-h-11 items-center rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8 sm:text-xs"
        >
          ← Back to Inbox Reality
        </Link>
      </div>

      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Pre-send predictor
        </h1>
        <p className="text-sm text-muted-foreground">
          Paste a draft, get a placement forecast before you hit send.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Draft</CardTitle>
            <CardDescription>
              Subject line and rendered HTML body.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <fieldset
              disabled={!hydrated || running || loadingCampaign}
              aria-busy={!hydrated || running || loadingCampaign}
              className="space-y-3"
            >
              {!hydrated ? (
                <span className="sr-only" role="status">
                  Preparing draft controls…
                </span>
              ) : null}
              {/* Load from an existing campaign (INBOX-025) + example/reset
                (INBOX-026). */}
              <div className="flex flex-wrap items-end gap-2">
                {campaignListLoading ? (
                  <p
                    role="status"
                    className="min-h-11 text-sm text-muted-foreground"
                  >
                    Loading campaigns…
                  </p>
                ) : campaignListError ? (
                  <div
                    role="alert"
                    className="flex w-full flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"
                  >
                    <p className="text-sm text-muted-foreground">
                      Campaigns are unavailable. You can still paste a draft or
                      load the example.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setCampaignListLoading(true);
                        setCampaignListError(false);
                        setCampaignListReloadKey((key) => key + 1);
                      }}
                    >
                      Retry campaigns
                    </Button>
                  </div>
                ) : campaigns.length > 0 ? (
                  <div className="flex-1 min-w-[180px] space-y-1.5">
                    <Label htmlFor="load-campaign">Load from campaign</Label>
                    <Select
                      id="load-campaign"
                      defaultValue=""
                      disabled={loadingCampaign}
                      onChange={(e) => void loadFromCampaign(e.target.value)}
                    >
                      <option value="">Select a campaign…</option>
                      {campaigns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name || c.subject || c.id}
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : (
                  <p className="w-full text-sm text-muted-foreground">
                    No campaigns are available to load yet.
                  </p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 sm:min-h-8"
                  onClick={loadExample}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Load example
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-11 sm:min-h-8"
                  onClick={clearAll}
                  disabled={!subject && !html && !result && !campaignDraftError}
                >
                  <Eraser className="h-3.5 w-3.5" />
                  Clear
                </Button>
                {loadingCampaign ? (
                  <p
                    role="status"
                    className="w-full text-sm text-muted-foreground"
                  >
                    Loading the selected campaign draft…
                  </p>
                ) : null}
              </div>

              <div
                className="space-y-3"
                onKeyDown={onFormKeyDown}
                role="group"
                aria-label="Draft input"
              >
                <div className="space-y-1.5">
                  <Label htmlFor="subject">Subject</Label>
                  <Input
                    id="subject"
                    value={subject}
                    onChange={(e) => {
                      setSubject(e.target.value);
                      setResult(null);
                      setError(null);
                      setCampaignDraftError(null);
                    }}
                    placeholder="Your subject line"
                    aria-describedby="subject-hint"
                  />
                  <p
                    id="subject-hint"
                    className={`text-xs ${TONE_CLASS[subjectHint.tone]}`}
                  >
                    {subjectHint.message}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="html">HTML body</Label>
                  <Textarea
                    id="html"
                    value={html}
                    onChange={(e) => {
                      setHtml(e.target.value);
                      setResult(null);
                      setError(null);
                      setCampaignDraftError(null);
                    }}
                    rows={16}
                    className="font-mono"
                    placeholder="<html>…"
                    aria-describedby="html-hint"
                  />
                  <p
                    id="html-hint"
                    className="flex flex-wrap gap-x-3 text-xs text-muted-foreground"
                  >
                    <span>{html.length.toLocaleString()} characters</span>
                    <span>
                      {linkCount} link{linkCount === 1 ? "" : "s"}
                    </span>
                    {!bodyIsHtml ? (
                      <span className="text-warning-emphasis">
                        Body doesn&apos;t look like HTML — the forecast may be
                        less accurate.
                      </span>
                    ) : null}
                  </p>
                </div>
                {campaignDraftError ? (
                  <p role="alert" className="text-sm text-destructive">
                    Could not load that campaign: {campaignDraftError}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    onClick={() => void run()}
                    disabled={running || (!html && !subject)}
                    aria-busy={running}
                  >
                    {running ? "Predicting…" : "Predict placement"}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {disabledReason || "or press ⌘/Ctrl + Enter"}
                  </span>
                </div>
              </div>
            </fieldset>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Forecast</CardTitle>
            <CardDescription>
              Estimated distribution across primary, promotions, spam.
            </CardDescription>
          </CardHeader>
          {/* Announce async result arrival to assistive tech (INBOX-015). */}
          <CardContent
            className="space-y-4"
            aria-live="polite"
            aria-busy={running}
          >
            {running ? (
              // Forecast-shaped skeleton while a prediction runs (INBOX-014).
              <div className="space-y-4" data-testid="forecast-skeleton">
                <Skeleton className="h-3 w-full rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              </div>
            ) : error ? (
              // Persistent inline error + Retry (INBOX-002).
              <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4" aria-hidden />
                  Prediction failed
                </div>
                <p className="text-sm text-muted-foreground">{error}</p>
                <Button size="sm" variant="outline" onClick={() => void run()}>
                  <RotateCw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              </div>
            ) : !result ? (
              <p className="text-sm text-muted-foreground italic">
                Run a prediction to see results.
              </p>
            ) : (
              <>
                <PlacementBar
                  primary={result.predicted.primary}
                  promotions={result.predicted.promotions}
                  spam={result.predicted.spam}
                  showLabels
                />

                <div>
                  <h4 className="text-sm font-semibold mb-2">
                    Contributing signals
                  </h4>
                  <ul className="text-sm space-y-1.5">
                    <li className="flex justify-between">
                      <span className="text-muted-foreground">
                        Spam classifier score
                      </span>
                      <Badge
                        variant={
                          result.content.spam_score > 0.4
                            ? "destructive"
                            : result.content.spam_score > 0.2
                              ? "warning"
                              : "success"
                        }
                      >
                        {result.content.spam_score.toFixed(2)}
                      </Badge>
                    </li>
                    <li className="flex justify-between">
                      <span className="text-muted-foreground">
                        Image-to-text ratio
                      </span>
                      <Badge
                        variant={
                          result.content.image_text_ratio > 4
                            ? "destructive"
                            : result.content.image_text_ratio > 2
                              ? "warning"
                              : "success"
                        }
                      >
                        {result.content.image_text_ratio.toFixed(2)}
                      </Badge>
                    </li>
                    <li className="flex justify-between">
                      <span className="text-muted-foreground">
                        Link reputation
                      </span>
                      <Badge
                        variant={
                          result.content.link_reputation === "fail"
                            ? "destructive"
                            : result.content.link_reputation === "warn"
                              ? "warning"
                              : "success"
                        }
                      >
                        {result.content.link_reputation}
                      </Badge>
                    </li>
                  </ul>

                  {/* Weighted risk-contribution breakdown the model already
                      computes (INBOX-003). */}
                  <div className="mt-4">
                    <h4 className="text-sm font-semibold mb-2">
                      Why this forecast
                    </h4>
                    <ul className="space-y-2">
                      {riskFactorRows(result.risk).map((row) => {
                        const band = riskBand(row.score);
                        return (
                          <li key={row.key} className="space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-medium">{row.label}</span>
                              <span className="text-muted-foreground">
                                weight {Math.round(row.weight * 100)}% · score{" "}
                                {row.score.toFixed(2)} ·{" "}
                                <span className="font-medium text-foreground">
                                  +{row.contribution.toFixed(3)}
                                </span>
                              </span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                              <div
                                className={`h-full ${RISK_BAND_BAR[band]}`}
                                style={{
                                  width: `${Math.min(100, Math.max(0, row.score * 100))}%`,
                                }}
                              />
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="mt-2 flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm">
                      <span className="font-medium">Combined risk</span>
                      <Badge
                        variant={
                          RISK_BAND_BADGE[riskBand(result.risk.combined)]
                        }
                      >
                        {result.risk.combined.toFixed(2)}
                      </Badge>
                    </div>
                  </div>

                  {cleanDraft ? (
                    <div className="mt-3 flex items-center gap-2 rounded-md border border-success/30 bg-success/5 p-3 text-sm text-success-emphasis">
                      <CheckCircle2 className="h-4 w-4" aria-hidden />
                      No content issues found in this draft.
                    </div>
                  ) : null}

                  {(result.content.spam_reasons?.length ?? 0) > 0 && (
                    <div className="mt-3 space-y-1">
                      <h5 className="text-xs font-semibold text-muted-foreground">
                        Reasons
                      </h5>
                      <div className="flex flex-wrap gap-1">
                        {result.content.spam_reasons?.map((r, i) => (
                          <Badge key={`${i}-${r}`} variant="warning">
                            {r}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {(result.content.html_issues?.length ?? 0) > 0 && (
                    <div className="mt-3 space-y-1">
                      <h5 className="text-xs font-semibold text-muted-foreground">
                        HTML issues
                      </h5>
                      <div className="flex flex-wrap gap-1">
                        {result.content.html_issues?.map((r, i) => (
                          <Badge key={`${i}-${r}`} variant="warning">
                            {r}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mt-4 rounded-md border p-3 text-xs text-muted-foreground">
                    <p>
                      Model: {result.risk.model.name || "placement heuristic"} (
                      {result.risk.model.kind})
                    </p>
                    {(result.risk.assumptions?.length ?? 0) > 0 && (
                      <ul className="mt-2 list-disc space-y-1 pl-4">
                        {result.risk.assumptions?.map((assumption) => (
                          <li key={assumption}>{assumption}</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Forward actions so the forecast isn't a dead end
                      (INBOX-027). */}
                  <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
                    <Button
                      size="sm"
                      onClick={() => void createFromDraft()}
                      disabled={creating || !canCreateCampaign}
                      title={createDeniedReason ?? undefined}
                    >
                      <SquarePen className="h-3.5 w-3.5" />
                      {creating
                        ? "Creating…"
                        : "Create campaign from this draft"}
                    </Button>
                    {meQuery.isFetched && !canCreateCampaign ? (
                      <span
                        className="inline-flex items-center text-xs text-muted-foreground"
                        role="note"
                      >
                        {CAMPAIGN_READ_ONLY_MESSAGE}
                      </span>
                    ) : !cleanDraft ? (
                      <span className="inline-flex items-center text-xs text-muted-foreground">
                        Create the campaign to fix flagged issues in the editor.
                      </span>
                    ) : null}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cross-client render preview — reuses the editor's component so a pasted
          draft gets both a placement forecast AND how it looks in real clients
          (INBOX-007). */}
      <Card>
        <CardHeader>
          <CardTitle>Cross-client preview</CardTitle>
          <CardDescription>
            How this HTML renders across Gmail, Outlook, Apple Mail, dark mode
            and more.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {html ? (
            <CrossClientPreview html={html} />
          ) : (
            <p className="text-sm text-muted-foreground italic">
              Paste HTML above to preview it across email clients.
            </p>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
