// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * CampaignSendCheckRows — the two client-run rows of the pre-send gate that
 * web had nowhere to run: the accessibility lint (parity row campaigns-31) and
 * the broken-link sweep (parity row campaigns-32).
 *
 * Both exist server-side and both were reachable from desktop's SendChecklist.
 * On web the a11y linter existed only as a standalone tool at /app/preflight
 * that lints HTML you paste in — a page you have to remember to visit BEFORE
 * you send — and the link checker was reachable from nowhere at all.
 *
 * ADVISORY, NEVER BLOCKING. Neither row feeds `sendGateDisabled`; see the
 * comment on the grading helpers in campaign-send-gate.ts for why. The gate is
 * the server checklist. These sit beside it in the same pass/warn/fail
 * vocabulary so the operator reads one list, not three.
 *
 * TWO HONEST-ABSENCE RULES:
 *   - The link sweep reads the LAST SAVED body, so an unsaved link is invisible
 *     to it. An empty sweep says "no links found in the saved body", never
 *     "all links fine".
 *   - The a11y linter grades HTML. A plain-text campaign has none, so the row
 *     says that rather than reporting a perfect score for an empty string.
 */

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import {
  a11yRowDetail,
  a11yRowStatus,
  linkRowDetail,
  linkRowStatus,
  linkStatusLabel,
  type SendCheckRowStatus,
} from "@/app/(dashboard)/app/campaigns/campaign-send-gate";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import { checkCampaignLinks } from "@/lib/campaign-send-checks-api";
import { checkAccessibility } from "@/lib/preflight-api";
import { qk, STALE, type RoleKey } from "@/lib/query-keys";

/**
 * FNV-1a over the linted inputs, so the cached verdict belongs to the body it
 * graded. Without it, editing the draft and re-opening the dialog inside the
 * stale window would show the OLD score for the NEW body — the one failure
 * mode a content lint cannot have. (The link sweep needs no such key: it reads
 * the saved row server-side, and saving invalidates the campaign key above it.)
 */
function contentFingerprint(...parts: string[]): string {
  let hash = 0x811c9dc5;
  const joined = parts.join("");
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const ROW_ICON: Record<SendCheckRowStatus, typeof CheckCircle2> = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
};
const ROW_COLOR: Record<SendCheckRowStatus, string> = {
  pass: "text-success",
  warn: "text-warning-emphasis",
  fail: "text-destructive",
};

function CheckRow({
  label,
  status,
  detail,
  pending,
  error,
  onRetry,
  disclosure,
  children,
  testId,
}: {
  label: string;
  status: SendCheckRowStatus | null;
  detail: string;
  pending: boolean;
  error: string | null;
  onRetry: () => void;
  disclosure?: { label: string; expanded: boolean; onToggle: () => void };
  children?: React.ReactNode;
  testId: string;
}) {
  const Icon = status ? ROW_ICON[status] : null;
  return (
    <li
      className="flex flex-col gap-1 text-sm"
      data-testid={testId}
      data-status={error ? "error" : pending ? "loading" : (status ?? "none")}
    >
      <div className="flex items-start gap-2">
        {pending ? (
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : Icon ? (
          <Icon
            className={`mt-0.5 h-4 w-4 shrink-0 ${status ? ROW_COLOR[status] : ""}`}
            aria-hidden
          />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="font-medium">{label}</span>
          <span className="text-muted-foreground"> — {detail}</span>
        </span>
        {error ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={onRetry}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        ) : disclosure ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            aria-expanded={disclosure.expanded}
            onClick={disclosure.onToggle}
          >
            {disclosure.label}
          </Button>
        ) : null}
      </div>
      {children}
    </li>
  );
}

export function CampaignSendCheckRows({
  bodyHtml,
  campaignId,
  enabled,
  role,
  subject,
  tenantId,
}: {
  bodyHtml: string;
  campaignId: string;
  enabled: boolean;
  role: RoleKey;
  subject: string;
  tenantId: string;
}) {
  const [a11yOpen, setA11yOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);

  const hasHtml = bodyHtml.trim().length > 0;
  const a11yQuery = useQuery({
    queryKey: [
      ...qk.campaign(tenantId, role, campaignId),
      "a11y-check",
      contentFingerprint(subject, "", bodyHtml),
    ],
    queryFn: ({ signal }) => checkAccessibility(bodyHtml, subject, { signal }),
    enabled: enabled && hasHtml,
    staleTime: STALE.list,
    retry: false,
  });
  const linksQuery = useQuery({
    queryKey: [...qk.campaign(tenantId, role, campaignId), "link-check"],
    queryFn: ({ signal }) => checkCampaignLinks(campaignId, { signal }),
    enabled,
    staleTime: STALE.list,
    retry: false,
  });

  if (!enabled) return null;

  const a11y = a11yQuery.data ?? null;
  const links = linksQuery.data ?? null;
  const a11yError = a11yQuery.isError
    ? apiErrorMessage(
        a11yQuery.error,
        "The accessibility check could not be run.",
      )
    : null;
  const linksError = linksQuery.isError
    ? apiErrorMessage(linksQuery.error, "The link check could not be run.")
    : null;

  const findings = a11y?.findings ?? [];
  const brokenFirst = [...(links ?? [])].sort(
    (a, b) => Number(a.ok) - Number(b.ok),
  );

  return (
    <div className="rounded-md border p-3" data-testid="campaign-send-checks">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Content checks
        </span>
        <span className="text-xs text-muted-foreground">
          Advisory — these do not block Send
        </span>
      </div>
      <ul className="space-y-2">
        <CheckRow
          testId="send-check-a11y"
          label="Accessibility"
          status={
            !hasHtml || a11yError
              ? null
              : a11y
                ? a11yRowStatus(a11y)
                : null
          }
          detail={
            !hasHtml
              ? "This campaign has no HTML body, so there is nothing to lint."
              : a11yError
                ? a11yError
                : a11yQuery.isPending
                  ? "Checking the body against WCAG 2.1 AA…"
                  : a11y
                    ? a11yRowDetail(a11y)
                    : "No accessibility result."
          }
          pending={hasHtml && a11yQuery.isPending}
          error={a11yError}
          onRetry={() => void a11yQuery.refetch()}
          disclosure={
            findings.length > 0
              ? {
                  label: a11yOpen
                    ? "Hide findings"
                    : `Findings (${findings.length})`,
                  expanded: a11yOpen,
                  onToggle: () => setA11yOpen((open) => !open),
                }
              : undefined
          }
        >
          {a11yOpen && findings.length > 0 ? (
            <ul className="ml-6 space-y-1.5 border-l pl-3 text-xs">
              {findings.map((finding, index) => (
                <li key={`${finding.rule}-${index}`}>
                  <span className="font-medium">{finding.rule}</span>
                  {finding.wcag ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · WCAG {finding.wcag}
                    </span>
                  ) : null}
                  <span
                    className={
                      finding.severity === "error"
                        ? " text-destructive"
                        : finding.severity === "warn"
                          ? " text-warning-emphasis"
                          : " text-muted-foreground"
                    }
                  >
                    {" "}
                    ({finding.severity})
                  </span>
                  <div className="text-muted-foreground">{finding.message}</div>
                  {finding.snippet ? (
                    <div
                      className="truncate font-mono text-[10px] text-muted-foreground"
                      title={finding.snippet}
                    >
                      {finding.snippet}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </CheckRow>

        <CheckRow
          testId="send-check-links"
          label="Links"
          status={linksError ? null : links ? linkRowStatus(links) : null}
          detail={
            linksError
              ? linksError
              : linksQuery.isPending
                ? "Checking every link in the saved body…"
                : links
                  ? linkRowDetail(links)
                  : "No link result."
          }
          pending={linksQuery.isPending}
          error={linksError}
          onRetry={() => void linksQuery.refetch()}
          disclosure={
            brokenFirst.length > 0
              ? {
                  label: linksOpen
                    ? "Hide links"
                    : `Links (${brokenFirst.length})`,
                  expanded: linksOpen,
                  onToggle: () => setLinksOpen((open) => !open),
                }
              : undefined
          }
        >
          {linksOpen && brokenFirst.length > 0 ? (
            <ul className="ml-6 space-y-1 border-l pl-3 text-xs">
              {brokenFirst.map((row, index) => (
                <li key={`${row.url}-${index}`} className="grid gap-0.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        row.ok
                          ? "shrink-0 text-muted-foreground"
                          : "shrink-0 font-medium text-destructive"
                      }
                    >
                      {row.ok ? "OK" : "Broken"}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {linkStatusLabel(row)}
                    </span>
                    <span
                      className="truncate text-muted-foreground"
                      title={row.url}
                    >
                      {row.url}
                    </span>
                  </div>
                  {/* Why no status came back, as visible text rather than a
                      tooltip keyboard and screen-reader users never reach. */}
                  {row.error ? (
                    <span className="text-muted-foreground">{row.error}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </CheckRow>
      </ul>
    </div>
  );
}
