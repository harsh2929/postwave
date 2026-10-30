// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * VoiceDriftBanner — the pre-send brand-voice check, at the one place a send is
 * confirmed.
 *
 * WHY IT LIVES IN THE SEND MODAL. The score itself is not the product; WHERE it
 * is offered is. A drift reading on an AI scratchpad tells an operator
 * something mildly interesting; the same reading inside the send confirmation
 * is the difference between catching off-brand copy and mailing it. Desktop
 * (apps/desktop/src/components/VoiceDriftBanner.tsx) and mobile
 * (apps/mobile/src/components/campaigns/CampaignSendModal.tsx) both put it
 * here; web had `checkVoiceDrift` sitting unused in lib/ai-compose-api.ts and
 * never called it from the send path.
 *
 * ADVISORY, NEVER BLOCKING. Drift is a signal, not a gate — an announcement or
 * a launch is a legitimate reason to step outside the usual voice. This banner
 * therefore has no effect on the Send button in any state, including `critical`
 * and including a failed check.
 *
 * FIVE HONEST STATES, each with its own testid:
 *   voice-drift-banner-empty     there is no candidate content to score
 *   voice-drift-banner-loading   the check is in flight
 *   voice-drift-banner-error     the check could not run (see below)
 *   voice-drift-banner-inactive  it ran, but there is no voice profile to score
 *                                against, so the "pass" it returned is
 *                                synthetic and must not be shown as a pass
 *   voice-drift-banner           a real score
 *
 * ON THE ERROR TEXT. The service answers `upstream_unavailable` both when no
 * voice service / LLM credential is configured and when the provider is down —
 * it cannot tell us which, so neither may we. The copy says only what is known.
 */

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useId, useState } from "react";

import {
  buildVoiceDriftRequest,
  getVoiceDriftReading,
  type VoiceDriftReading,
} from "@/lib/ai-compose-api";
import { ApiError } from "@/lib/api";
import { qk, STALE, type RoleKey } from "@/lib/query-keys";

/** Statuses that mean "this capability is not wired up here", not "it failed". */
const UNCONFIGURED_STATUS = new Set([404, 405, 501, 502, 503]);
const UNCONFIGURED_CODE = new Set([
  "upstream_unavailable",
  "feature_disabled",
  "not_implemented",
]);

function describeFailure(err: unknown): string {
  if (err instanceof ApiError) {
    if (
      UNCONFIGURED_STATUS.has(err.status) ||
      UNCONFIGURED_CODE.has(err.code)
    ) {
      // Deliberately no remedy: "add a provider key" would be a guess that can
      // send someone to change a setting that is already correct.
      return "Voice drift check unavailable — the voice service is not responding for this workspace.";
    }
    return `Voice drift check failed: ${err.message}`;
  }
  return "Voice drift check failed.";
}

/**
 * The voice service returns a synthetic `{score: 100, severity: "ok"}` for
 * tenants with no voice profile, carrying a disclaimer in `suggestions`. A
 * green "On brand" render would turn that into a fabricated pass.
 */
function isSyntheticPass(reading: VoiceDriftReading): boolean {
  if (reading.severity !== "ok") return false;
  return (reading.suggestions ?? []).some((s) =>
    /drift check is inactive|no voice profile|no active profile/i.test(s),
  );
}

const SEVERITY_LABEL: Record<VoiceDriftReading["severity"], string> = {
  ok: "On brand",
  warn: "Voice drift detected",
  critical: "Strong voice drift",
};
const SEVERITY_CLASS: Record<VoiceDriftReading["severity"], string> = {
  ok: "border-success/40 text-success",
  warn: "border-warning/40 text-warning-emphasis",
  critical: "border-destructive/40 text-destructive-emphasis",
};

export function VoiceDriftBanner({
  bodyHtml,
  bodyText,
  campaignId,
  enabled,
  role,
  tenantId,
}: {
  bodyHtml: string;
  bodyText: string;
  campaignId: string;
  enabled: boolean;
  role: RoleKey;
  tenantId: string;
}) {
  const detailsId = useId();
  const [detailsFor, setDetailsFor] = useState<VoiceDriftReading | null>(null);
  const request = buildVoiceDriftRequest({ html: bodyHtml, text: bodyText });

  const driftQuery = useQuery({
    // The effective request belongs in the key. Campaign id alone reused the
    // previous score after copy changed, and a slower old request could then
    // look like the result for the new body.
    queryKey: [
      ...qk.campaign(tenantId, role, campaignId),
      "voice-drift",
      request,
    ],
    queryFn: ({ signal }) => {
      if (!request) {
        return Promise.reject(
          new Error("Voice drift requires campaign content."),
        );
      }
      return getVoiceDriftReading(
        {
          html: request.html,
          text: request.text,
          profileId: request.profile_id,
        },
        { signal },
      );
    },
    enabled: enabled && request !== null,
    staleTime: STALE.list,
    // One shot. A retry storm inside a send confirmation buys nothing — the
    // reading is advisory and the operator is waiting.
    retry: false,
  });

  if (!enabled) return null;

  if (!request) {
    return (
      <p
        role="status"
        data-testid="voice-drift-banner-empty"
        className="break-words text-xs text-muted-foreground"
      >
        Voice drift check skipped — add campaign content to check brand voice
        before sending.
      </p>
    );
  }

  if (driftQuery.isPending) {
    return (
      <p
        role="status"
        data-testid="voice-drift-banner-loading"
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
        Checking voice fidelity…
      </p>
    );
  }

  if (driftQuery.isError) {
    return (
      <p
        role="status"
        data-testid="voice-drift-banner-error"
        className="break-words text-xs text-muted-foreground"
      >
        {describeFailure(driftQuery.error)}
      </p>
    );
  }

  const reading = driftQuery.data;
  if (!reading) return null;

  if (isSyntheticPass(reading)) {
    return (
      <p
        role="status"
        data-testid="voice-drift-banner-inactive"
        className="break-words text-xs text-muted-foreground"
      >
        Voice drift check inactive — build a voice profile under Sequences →
        Voice profile to get brand-voice warnings before a send.
      </p>
    );
  }

  const severity = reading.severity;
  const isOk = severity === "ok";
  const suggestions = (reading.suggestions ?? []).slice(0, 3);
  const detailsOpen = detailsFor === reading;

  return (
    <div
      data-testid="voice-drift-banner"
      data-severity={severity}
      className={`min-w-0 rounded-md border px-3 py-2 text-sm ${SEVERITY_CLASS[severity]}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          role="status"
          className="flex min-w-0 items-center gap-1.5 font-medium"
        >
          {isOk ? (
            <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
          )}
          {SEVERITY_LABEL[severity]} —{" "}
          <span className="tabular-nums">{Math.round(reading.score)}/100</span>
        </span>
        {!isOk && suggestions.length > 0 ? (
          <button
            type="button"
            aria-controls={detailsId}
            aria-expanded={detailsOpen}
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md px-2 text-xs underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={() =>
              setDetailsFor((current) => (current === reading ? null : reading))
            }
          >
            {detailsOpen ? "Hide details" : "Why?"}
          </button>
        ) : null}
      </div>
      {reading.reason && !isOk ? (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {reading.reason}
        </p>
      ) : null}
      {suggestions.length > 0 ? (
        <ul
          id={detailsId}
          hidden={!detailsOpen}
          className="mt-1.5 list-disc space-y-1 break-words pl-4 text-xs text-muted-foreground"
        >
          {suggestions.map((suggestion, index) => (
            <li key={`${index}-${suggestion}`}>{suggestion}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-1.5 text-xs text-muted-foreground">
        Advisory only — this never blocks a send.
      </p>
    </div>
  );
}
