import { useCallback, useEffect, useRef, useState } from "react";

import {
  type CampaignAssuranceEnvelope,
  type CampaignAssuranceEvidence,
  type CampaignAssuranceLatest,
  type CampaignContentRevision,
  getCampaignAssuranceEvidence,
  getCampaignContentRevision,
  getLatestCampaignAssurance,
} from "../../lib/api/campaign-assurance";

export type CampaignAssuranceState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      latest: CampaignAssuranceEnvelope<CampaignAssuranceLatest>;
      evidence: CampaignAssuranceEvidence | null;
      evidenceError: string | null;
      revision: CampaignContentRevision | null;
      revisionError: string | null;
    };

const TERMINAL_STATES = new Set([
  "complete",
  "incomplete",
  "failed",
  "cancelled",
  "stale",
]);

export function useCampaignAssurance(
  campaignId: string | null,
  options: { withDetails?: boolean } = {},
) {
  const withDetails = options.withDetails !== false;
  const [state, setState] = useState<CampaignAssuranceState>({
    status: "loading",
  });
  const [refreshToken, setRefreshToken] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const generationRef = useRef(0);

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  useEffect(() => {
    const generation = ++generationRef.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!campaignId) {
      setState({ status: "error", message: "Campaign identity is unavailable." });
      return;
    }
    setState({ status: "loading" });
    setLoadingMore(false);

    const load = async (): Promise<void> => {
      let latestResult: Awaited<ReturnType<typeof getLatestCampaignAssurance>>;
      try {
        latestResult = await getLatestCampaignAssurance(campaignId);
      } catch (error) {
        if (generationRef.current !== generation) return;
        setState({
          status: "error",
          message:
            error instanceof Error && error.message
              ? error.message
              : "Campaign Assurance evidence is unavailable.",
        });
        return;
      }
      if (generationRef.current !== generation) return;
      if (latestResult.error) {
        setState(
          latestResult.error.status === 404
            ? { status: "missing" }
            : {
                status: "error",
                message:
                  latestResult.error.message ||
                  "Campaign Assurance evidence is unavailable.",
              },
        );
        return;
      }
      if (!latestResult.data) {
        setState({
          status: "error",
          message: "Campaign Assurance returned an empty response.",
        });
        return;
      }
      const latest = latestResult.data;
      const run = latest.data.detail.run;
      if (!withDetails) {
        setState({
          status: "ready",
          latest,
          evidence: null,
          evidenceError: null,
          revision: null,
          revisionError: null,
        });
        if (!TERMINAL_STATES.has(run.state)) {
          timer = setTimeout(() => {
            if (generationRef.current === generation) void load();
          }, 2_000);
        }
        return;
      }
      let evidenceResult: Awaited<
        ReturnType<typeof getCampaignAssuranceEvidence>
      >;
      let revisionResult: Awaited<ReturnType<typeof getCampaignContentRevision>>;
      try {
        [evidenceResult, revisionResult] = await Promise.all([
          getCampaignAssuranceEvidence(campaignId, run.id),
          getCampaignContentRevision(campaignId, run.content_revision_id),
        ]);
      } catch (error) {
        if (generationRef.current !== generation) return;
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Supporting receipt evidence is unavailable.";
        setState({
          status: "ready",
          latest,
          evidence: null,
          evidenceError: message,
          revision: null,
          revisionError: message,
        });
        return;
      }
      if (generationRef.current !== generation) return;
      setState({
        status: "ready",
        latest,
        evidence: evidenceResult.data?.data ?? null,
        evidenceError: evidenceResult.error?.message ?? null,
        revision: revisionResult.data ?? null,
        revisionError: revisionResult.error?.message ?? null,
      });
      if (!TERMINAL_STATES.has(run.state)) {
        timer = setTimeout(() => {
          if (generationRef.current === generation) void load();
        }, 2_000);
      }
    };

    void load();
    return () => {
      generationRef.current += 1;
      if (timer) clearTimeout(timer);
    };
  }, [campaignId, refreshToken, withDetails]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (
      !campaignId ||
      state.status !== "ready" ||
      !state.evidence ||
      loadingMore
    ) {
      return;
    }
    const offset = nextEvidenceOffset(state.evidence);
    if (offset === undefined) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    let result: Awaited<ReturnType<typeof getCampaignAssuranceEvidence>>;
    try {
      result = await getCampaignAssuranceEvidence(
        campaignId,
        state.latest.data.detail.run.id,
        offset,
      );
    } catch (error) {
      if (generationRef.current !== generation) return;
      setLoadingMore(false);
      setState((current) =>
        current.status === "ready"
          ? {
              ...current,
              evidenceError:
                error instanceof Error && error.message
                  ? error.message
                  : "More immutable evidence could not be loaded.",
            }
          : current,
      );
      return;
    }
    if (generationRef.current !== generation) return;
    setLoadingMore(false);
    setState((current) => {
      if (current.status !== "ready") return current;
      if (result.error) {
        return { ...current, evidenceError: result.error.message };
      }
      if (!result.data) return current;
      return {
        ...current,
        evidence: mergeEvidence(current.evidence, result.data.data),
        evidenceError: null,
      };
    });
  }, [campaignId, loadingMore, state]);

  return { state, refresh, loadMore, loadingMore };
}

function nextEvidenceOffset(
  evidence: CampaignAssuranceEvidence,
): number | undefined {
  return [
    evidence.extractions.next_offset,
    evidence.findings.next_offset,
    evidence.overrides.next_offset,
  ]
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b)[0];
}

function mergeEvidence(
  current: CampaignAssuranceEvidence | null,
  next: CampaignAssuranceEvidence,
): CampaignAssuranceEvidence {
  if (!current) return next;
  return {
    ...next,
    source_classes: [...new Set([...current.source_classes, ...next.source_classes])],
    extractions: {
      ...next.extractions,
      items: mergeById(current.extractions.items, next.extractions.items),
    },
    findings: {
      ...next.findings,
      items: mergeById(current.findings.items, next.findings.items),
    },
    overrides: {
      ...next.overrides,
      items: mergeById(current.overrides.items, next.overrides.items),
    },
  };
}

function mergeById<T extends { id: string }>(current: T[], next: T[]): T[] {
  const rows = new Map(current.map((item) => [item.id, item]));
  for (const item of next) rows.set(item.id, item);
  return [...rows.values()];
}
