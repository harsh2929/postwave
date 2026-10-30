import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type BestSendTime,
  type SegmentBestSendTime,
  type SegmentHeatmapResponse,
  type SubscriberOpenPattern,
  apiSendTimeAssets as api,
  getSendTimeOptimization,
  putSendTimeOptimization,
} from "../../lib/api-client";
import { type Segment, segmentsClient } from "../segments/segmentsClient";
import { toast } from "../Toast";
import {
  decodeBestSendTime,
  decodeSegmentBest,
  decodeSegmentHeatmap,
  decodeSubscriberPattern,
} from "./contract";
import {
  describeApiError,
  isSubscriberUuid,
  normalizeSubscriberUuid,
} from "./model";

export type WorkspaceSettingState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; enabled: boolean };

export function useSendTimeWorkspaceSetting({
  canAdmin,
  identityKey,
}: {
  canAdmin: boolean;
  identityKey: string;
}) {
  const generation = useRef(0);
  const mounted = useRef(true);
  const [state, setState] = useState<WorkspaceSettingState>({
    kind: "loading",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const request = ++generation.current;
    setState({ kind: "loading" });
    const response = await getSendTimeOptimization();
    if (!mounted.current || request !== generation.current) return;
    if (response.error) {
      setState({
        kind: "error",
        message: describeApiError(response.error),
      });
      return;
    }
    if (
      !response.data ||
      typeof (response.data as { enabled?: unknown }).enabled !== "boolean"
    ) {
      setState({
        kind: "error",
        message: "The workspace setting response did not match its contract.",
      });
      return;
    }
    setState({ kind: "ready", enabled: response.data.enabled });
  }, []);

  useEffect(() => {
    generation.current += 1;
    setSaving(false);
    void load();
  }, [identityKey, load]);

  const setEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!canAdmin || saving || state.kind !== "ready") return;
      const request = ++generation.current;
      setSaving(true);
      const response = await putSendTimeOptimization({ enabled });
      if (!mounted.current || request !== generation.current) return;
      setSaving(false);
      if (response.error) {
        toast.error(
          `Couldn't update send-time optimization: ${describeApiError(response.error)}`,
        );
        await load();
        return;
      }
      if (
        !response.data ||
        typeof (response.data as { enabled?: unknown }).enabled !== "boolean"
      ) {
        toast.error(
          "The workspace default response did not match its contract.",
        );
        await load();
        return;
      }
      setState({ kind: "ready", enabled: response.data.enabled });
      toast.success(
        `Personalized timing is ${response.data.enabled ? "on" : "off"} by default for new campaigns.`,
      );
    },
    [canAdmin, load, saving, state],
  );

  return {
    state,
    saving,
    load,
    setEnabled,
    enabled: state.kind === "ready" && state.enabled,
  };
}

export type SegmentCatalogState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; segments: Segment[] };

export type AudienceSignalState =
  | { kind: "unscoped" }
  | { kind: "loading" }
  | {
      kind: "ready";
      heatmap: SegmentHeatmapResponse;
      best: SegmentBestSendTime | null;
      bestWarning: string | null;
    }
  | { kind: "insufficient"; message: string }
  | { kind: "error"; message: string };

function storedSegmentKey(identityKey: string): string {
  return `pw.sendtime.segment.${identityKey || "unresolved"}`;
}

function readStoredSegment(identityKey: string): string {
  try {
    return localStorage.getItem(storedSegmentKey(identityKey)) ?? "";
  } catch {
    return "";
  }
}

function writeStoredSegment(identityKey: string, segmentId: string): void {
  try {
    if (segmentId) {
      localStorage.setItem(storedSegmentKey(identityKey), segmentId);
    } else {
      localStorage.removeItem(storedSegmentKey(identityKey));
    }
  } catch {
    // Storage can be unavailable in hardened or private desktop profiles.
  }
}

export function useSendTimeAudienceSignals(identityKey: string) {
  const catalogGeneration = useRef(0);
  const signalGeneration = useRef(0);
  const mounted = useRef(true);
  const [catalog, setCatalog] = useState<SegmentCatalogState>({
    kind: "loading",
  });
  const [selectedSegmentId, setSelectedSegmentIdState] = useState("");
  const [signal, setSignal] = useState<AudienceSignalState>({
    kind: "unscoped",
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      catalogGeneration.current += 1;
      signalGeneration.current += 1;
    };
  }, []);

  const loadSegments = useCallback(async (): Promise<void> => {
    const request = ++catalogGeneration.current;
    signalGeneration.current += 1;
    setCatalog({ kind: "loading" });
    setSignal({ kind: "unscoped" });
    const response = await segmentsClient.list();
    if (!mounted.current || request !== catalogGeneration.current) return;
    if (response.error) {
      setCatalog({
        kind: "error",
        message: describeApiError(response.error),
      });
      setSelectedSegmentIdState("");
      return;
    }
    if (
      !Array.isArray(response.data) ||
      response.data.some(
        (segment) =>
          !segment ||
          typeof segment.id !== "string" ||
          !segment.id ||
          typeof segment.name !== "string" ||
          !segment.name.trim(),
      )
    ) {
      setCatalog({
        kind: "error",
        message: "The segment catalog response did not match its contract.",
      });
      setSelectedSegmentIdState("");
      return;
    }
    const segments = [...response.data].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
    setCatalog({ kind: "ready", segments });
    const stored = readStoredSegment(identityKey);
    const restored = segments.some((segment) => segment.id === stored)
      ? stored
      : "";
    setSelectedSegmentIdState(restored);
    if (!restored) setSignal({ kind: "unscoped" });
  }, [identityKey]);

  useEffect(() => {
    catalogGeneration.current += 1;
    signalGeneration.current += 1;
    setSelectedSegmentIdState("");
    setSignal({ kind: "unscoped" });
    void loadSegments();
  }, [identityKey, loadSegments]);

  const loadSignal = useCallback(async (segmentId: string): Promise<void> => {
    if (!segmentId) {
      signalGeneration.current += 1;
      setSignal({ kind: "unscoped" });
      return;
    }
    const request = ++signalGeneration.current;
    setSignal({ kind: "loading" });
    const [heatmap, best] = await Promise.all([
      api.getSegmentHeatmap({ segmentId }),
      api.getSegmentBestSendTime({ segmentId }),
    ]);
    if (!mounted.current || request !== signalGeneration.current) return;
    if (heatmap.error) {
      if (heatmap.error.status === 404) {
        setSignal({
          kind: "insufficient",
          message:
            "This segment does not yet have enough members with engagement history to produce a reliable pattern.",
        });
      } else {
        setSignal({
          kind: "error",
          message: describeApiError(heatmap.error),
        });
      }
      return;
    }
    const decodedHeatmap = decodeSegmentHeatmap(heatmap.data);
    if (!decodedHeatmap) {
      setSignal({
        kind: "error",
        message:
          "The audience analysis response did not match its 7 × 24 data contract.",
      });
      return;
    }
    const decodedBest = best.error ? null : decodeSegmentBest(best.data);
    setSignal({
      kind: "ready",
      heatmap: decodedHeatmap,
      best: decodedBest,
      bestWarning: best.error
        ? describeApiError(best.error)
        : decodedBest
          ? null
          : "The model-coverage response did not match its contract.",
    });
  }, []);

  useEffect(() => {
    void loadSignal(selectedSegmentId);
  }, [loadSignal, selectedSegmentId]);

  const setSelectedSegmentId = useCallback(
    (segmentId: string): void => {
      writeStoredSegment(identityKey, segmentId);
      setSelectedSegmentIdState(segmentId);
    },
    [identityKey],
  );

  const selectedSegment = useMemo(() => {
    if (catalog.kind !== "ready") return null;
    return (
      catalog.segments.find((segment) => segment.id === selectedSegmentId) ??
      null
    );
  }, [catalog, selectedSegmentId]);

  return {
    catalog,
    selectedSegment,
    selectedSegmentId,
    setSelectedSegmentId,
    signal,
    loadSegments,
    reloadSignal: () => loadSignal(selectedSegmentId),
  };
}

export type SubscriberLookupState =
  | { kind: "idle" }
  | { kind: "loading"; lookupKey: string }
  | { kind: "cold"; lookupKey: string }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      lookupKey: string;
      recommendation: BestSendTime;
      pattern: SubscriberOpenPattern | null;
      patternWarning: string | null;
    };

export function useSubscriberSendTimeLookup(identityKey: string) {
  const generation = useRef(0);
  const mounted = useRef(true);
  const [lookupId, setLookupIdState] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [state, setState] = useState<SubscriberLookupState>({ kind: "idle" });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  useEffect(() => {
    generation.current += 1;
    setLookupIdState("");
    setInputError(null);
    setState({ kind: "idle" });
  }, [identityKey]);

  const setLookupId = useCallback((value: string): void => {
    generation.current += 1;
    setLookupIdState(value);
    setInputError(null);
    setState({ kind: "idle" });
  }, []);

  const clear = useCallback((): void => {
    generation.current += 1;
    setLookupIdState("");
    setInputError(null);
    setState({ kind: "idle" });
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    const lookupKey = normalizeSubscriberUuid(lookupId);
    if (!isSubscriberUuid(lookupKey)) {
      setInputError(
        "Enter a full subscriber UUID (8-4-4-4-12 hexadecimal format).",
      );
      return;
    }
    setInputError(null);
    const request = ++generation.current;
    setState({ kind: "loading", lookupKey });
    const [recommendation, pattern] = await Promise.all([
      api.getBestSendTime(lookupKey),
      api.getSubscriberOpenPattern(lookupKey),
    ]);
    if (!mounted.current || request !== generation.current) return;
    if (recommendation.error) {
      if (recommendation.error.status === 404) {
        setState({ kind: "cold", lookupKey });
      } else {
        setState({
          kind: "error",
          message: describeApiError(recommendation.error),
        });
      }
      return;
    }
    const decodedRecommendation = decodeBestSendTime(recommendation.data);
    if (!decodedRecommendation) {
      setState({
        kind: "error",
        message:
          "The subscriber recommendation response did not match its contract.",
      });
      return;
    }
    if (
      !Number.isInteger(decodedRecommendation.best_hour_utc) ||
      decodedRecommendation.best_hour_utc < 0
    ) {
      setState({ kind: "cold", lookupKey });
      return;
    }
    const decodedPattern = pattern.error
      ? null
      : decodeSubscriberPattern(pattern.data);
    setState({
      kind: "ready",
      lookupKey,
      recommendation: decodedRecommendation,
      pattern: decodedPattern,
      patternWarning:
        pattern.error && pattern.error.status !== 404
          ? describeApiError(pattern.error)
          : !pattern.error && !decodedPattern
            ? "The weekly pattern response did not match its 7 × 24 data contract."
            : null,
    });
  }, [lookupId]);

  return {
    lookupId,
    setLookupId,
    inputError,
    state,
    submit,
    clear,
  };
}
