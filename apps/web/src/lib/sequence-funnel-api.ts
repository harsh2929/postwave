// SPDX-License-Identifier: AGPL-3.0-only
//
// Sequence funnel reads for the Analytics page's "Top sequence funnel" panel
// (desktop AnalyticsHealthPanels SequenceFunnelPanel, fed by
// useAnalyticsDashboardController.ts:185,309):
//
//   GET /api/v1/voice/sequences              → the workspace's sequences
//   GET /api/v1/voice/sequences/{id}/funnel  → per-step reach / opens / clicks
//
// Both parsers are strict about shape and lenient about noise: a list that
// arrives in an envelope ({items|sequences|data: [...]}) is unwrapped, a
// non-array is an error (never an empty list), and funnel counters that are
// missing or non-numeric read as 0 while a steps field that isn't an array is
// rejected outright rather than drawn as "no steps".

import { api } from "./api";

type RequestOptions = { signal?: AbortSignal };

export interface VoiceSequenceSummary {
  id: string;
  name: string;
}

export interface SequenceFunnelStep {
  position: number;
  /** Branch steps share a position; the server keys them by step_id. */
  stepId: string | null;
  reached: number;
  opened: number;
  clicked: number;
  /** Fractions in [0, 1]. */
  openRate: number;
  clickRate: number;
  /** Fraction of the previous position's cohort that did not reach this one. */
  dropoffPct: number;
}

export interface SequenceFunnel {
  sequenceId: string;
  steps: SequenceFunnelStep[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseVoiceSequenceList(payload: unknown): VoiceSequenceSummary[] {
  const envelope = record(payload);
  const rows = Array.isArray(payload)
    ? payload
    : envelope
      ? (envelope.items ?? envelope.sequences ?? envelope.data)
      : undefined;
  if (!Array.isArray(rows)) {
    throw new Error("The sequence list came back in an unexpected shape.");
  }
  const out: VoiceSequenceSummary[] = [];
  for (const row of rows) {
    const item = record(row);
    if (!item) continue;
    const id =
      typeof item.id === "string"
        ? item.id.trim()
        : typeof item.id === "number"
          ? String(item.id)
          : "";
    if (!id) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    out.push({ id, name: name || "Untitled sequence" });
  }
  return out;
}

export function parseSequenceFunnel(
  payload: unknown,
  requestedId: string,
): SequenceFunnel {
  const root = record(payload);
  if (!root || !Array.isArray(root.steps)) {
    throw new Error("The sequence funnel came back in an unexpected shape.");
  }
  const steps: SequenceFunnelStep[] = [];
  for (const raw of root.steps) {
    const step = record(raw);
    if (!step) continue;
    steps.push({
      position: num(step.position),
      stepId:
        typeof step.step_id === "string" && step.step_id ? step.step_id : null,
      reached: num(step.reached),
      opened: num(step.opened),
      clicked: num(step.clicked),
      openRate: num(step.open_rate),
      clickRate: num(step.click_rate),
      dropoffPct: num(step.dropoff_pct),
    });
  }
  return {
    sequenceId:
      typeof root.sequence_id === "string" && root.sequence_id
        ? root.sequence_id
        : requestedId,
    steps,
  };
}

export async function listVoiceSequenceSummaries(
  opts?: RequestOptions,
): Promise<VoiceSequenceSummary[]> {
  return parseVoiceSequenceList(
    await api.get<unknown>("/api/v1/voice/sequences", opts),
  );
}

export async function getSequenceFunnel(
  id: string,
  opts?: RequestOptions,
): Promise<SequenceFunnel> {
  return parseSequenceFunnel(
    await api.get<unknown>(
      `/api/v1/voice/sequences/${encodeURIComponent(id)}/funnel`,
      opts,
    ),
    id,
  );
}
