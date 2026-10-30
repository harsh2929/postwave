// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleDot, Download, Info, ShieldCheck } from "lucide-react";

import {
  GovernanceError,
  GovernanceLoading,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import {
  AGENT_ACTIVITY_WINDOW_DAYS,
  MAX_AIVS_SESSION_ID_LENGTH,
  agentActivityWindowStart,
  downloadAIVSBundle,
  getAgentAuditActivity,
  isSendableAIVSSessionId,
} from "@/lib/audit-compliance-api";
import { downloadBlobFile } from "@/lib/download";
import { base, STALE, type RoleKey } from "@/lib/query-keys";

/**
 * Rows below the live check describe what the PLATFORM ships. They are not
 * verified per tenant at render time, so they are labelled as capability
 * statements rather than drawn as green ticks — a tick this page cannot
 * substantiate is the one thing an Article 50 readiness screen must not show.
 */
const PLATFORM_CAPABILITIES: ReadonlyArray<{ label: string; detail: string }> = [
  {
    label: "AI agent audit logging",
    detail:
      "Every agent actor (claude-code, postwave-ai, and the rest) is recorded " +
      "on audit_log with actor_type='agent'.",
  },
  {
    label: "AIVS proof bundles available per session",
    detail:
      "GET /api/v1/audit/ai-session/{session_id}/aivs-bundle returns a .tar.gz " +
      "holding manifest.json, events.jsonl, chain.json and verify.py.",
  },
  {
    label: "Model ID and tool calls captured per row",
    detail:
      "The agent metadata schema reserves prompt_hash, model_id, tool_calls " +
      "and output_hash; they are populated when a handler attaches AI context.",
  },
  {
    label: "Offline verifier shipped inside every bundle",
    detail:
      "verify.py is Python 3 stdlib-only and checks the SHA-256 chain plus the " +
      "Ed25519 signature against the public key embedded in the manifest.",
  },
];

export function Article50Panel({
  tenantId,
  role,
  enabled,
}: {
  tenantId: string;
  role: RoleKey;
  enabled: boolean;
}) {
  // Floored to UTC midnight inside the helper, so this memo does not have to
  // re-run to stay stable and the query key does not churn between renders.
  const since = useMemo(() => agentActivityWindowStart(new Date()), []);
  const activity = useQuery({
    queryKey: [...base("audit-agent-activity", tenantId, role), since],
    queryFn: ({ signal }) => getAgentAuditActivity(since, { signal }),
    enabled,
    staleTime: STALE.dashboard,
    retry: false,
  });

  return (
    <GovernanceSection
      icon={ShieldCheck}
      title="Article 50 transparency (EU AI Act)"
      description="Article 50 obliges a provider of a content-generating AI system to disclose the AI involvement and to keep records good enough for downstream verification. AIVS bundles cover the record-keeping half: a portable, offline-verifiable proof that logged agent actions match what the system did."
    >
      {activity.isPending && enabled ? (
        <GovernanceLoading label="Counting agent activity…" rows={2} />
      ) : activity.isError ? (
        <GovernanceError
          message={`The agent-activity check could not be run, so nothing is claimed about it. ${apiErrorMessage(
            activity.error,
            "The request failed.",
          )}`}
          retrying={activity.isFetching}
          onRetry={() => void activity.refetch()}
        />
      ) : (
        <ul className="space-y-2.5">
          <li className="min-w-0 rounded-lg border bg-muted/20 p-3.5">
            <div className="flex min-w-0 items-start gap-2.5">
              <CircleDot
                className={
                  activity.data && activity.data.totalEvents > 0
                    ? "mt-0.5 size-4 shrink-0 text-success-emphasis"
                    : "mt-0.5 size-4 shrink-0 text-muted-foreground"
                }
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-5">
                  Agent activity observed in the last{" "}
                  {AGENT_ACTIVITY_WINDOW_DAYS} days
                </p>
                <p className="mt-1 break-words text-sm leading-5 text-muted-foreground">
                  {activity.data
                    ? `${activity.data.totalEvents.toLocaleString()} agent-actor ${
                        activity.data.totalEvents === 1 ? "event" : "events"
                      } since ${activity.data.since}.`
                    : "Not checked for this session."}
                </p>
              </div>
            </div>
          </li>
          {PLATFORM_CAPABILITIES.map((item) => (
            <li
              key={item.label}
              className="min-w-0 rounded-lg border bg-muted/20 p-3.5"
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <Info
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold leading-5">
                    {item.label}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      · platform capability, not a tenant check
                    </span>
                  </p>
                  <p className="mt-1 break-words text-sm leading-5 text-muted-foreground">
                    {item.detail}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AIVSBundleExport enabled={enabled} />
    </GovernanceSection>
  );
}

/**
 * One-shot export of a session's signed proof bundle.
 *
 * The bundle is confidential tenant evidence, so the download is offered only
 * where the rest of the compliance evidence is: the page's owner/admin gate.
 */
function AIVSBundleExport({ enabled }: { enabled: boolean }) {
  const [sessionId, setSessionId] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const download = useMutation({
    mutationFn: (id: string) => downloadAIVSBundle(id),
    onSuccess: (bundle) => {
      downloadBlobFile(bundle.filename, bundle.blob);
      setSaved(bundle.filename);
    },
  });

  const trimmed = sessionId.trim();
  const sendable = isSendableAIVSSessionId(sessionId);
  // Stated rather than left as a mysteriously dead button. This is a FORMAT
  // rule the server publishes (400 bad_session_id), not a refusal — a refusal
  // is only ever rendered from the server's own sentence.
  const tooLong = trimmed.length > MAX_AIVS_SESSION_ID_LENGTH;

  return (
    <div className="mt-4 min-w-0 rounded-lg border bg-card p-3.5">
      <p className="text-sm font-semibold leading-5">
        Export an AIVS bundle for an inspector
      </p>
      <p className="mt-1 text-sm leading-5 text-muted-foreground">
        Paste the session_id shown on an agent row in the audit log. The bundle
        is confidential workspace evidence; it downloads straight to this
        device.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Label htmlFor="aivs-session-id">Session ID</Label>
          <Input
            id="aivs-session-id"
            className="mt-1.5"
            value={sessionId}
            placeholder="session_id"
            autoComplete="off"
            spellCheck={false}
            disabled={!enabled}
            aria-invalid={tooLong || undefined}
            aria-describedby={tooLong ? "aivs-session-id-hint" : undefined}
            onChange={(event) => {
              setSessionId(event.target.value);
              setSaved(null);
              download.reset();
            }}
          />
          {tooLong ? (
            <p
              id="aivs-session-id-hint"
              className="mt-1.5 text-sm leading-5 text-destructive-emphasis"
            >
              A session ID is at most {MAX_AIVS_SESSION_ID_LENGTH} characters;
              this one is {trimmed.length.toLocaleString()}.
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          disabled={!enabled || !sendable}
          loading={download.isPending}
          onClick={() => download.mutate(trimmed)}
        >
          {!download.isPending ? <Download aria-hidden="true" /> : null}
          {download.isPending ? "Building bundle…" : "Download AIVS bundle"}
        </Button>
      </div>
      {download.isError ? (
        <Alert variant="destructive" className="mt-3">
          <AlertTitle>No bundle was downloaded</AlertTitle>
          <AlertDescription>
            {apiErrorMessage(
              download.error,
              "The bundle could not be built for this session.",
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {saved && !download.isError ? (
        <p role="status" className="mt-3 text-sm leading-5 text-muted-foreground">
          Downloaded {saved}.
        </p>
      ) : null}
    </div>
  );
}
