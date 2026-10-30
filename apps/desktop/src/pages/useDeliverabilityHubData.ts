import { useCallback, useEffect, useRef, useState } from "react";

import {
  type BlocklistHit,
  type BounceClassBreakdownResponse,
  type DeliverabilityHubHistoryResponse,
  type DeliverabilityHubSummary,
  type DnsHealthStatus,
  type WebhookErrorRow,
  deliverabilityHubApi,
} from "../lib/api-client";
import { useMe } from "../lib/store";
import {
  parseBlocklistHits,
  parseBounceClassBreakdown,
  parseDeliverabilityHistory,
  parseDeliverabilitySummary,
  parseDnsHealthRows,
  parseWebhookErrors,
} from "./deliverability-hub-response-contract";

export const DELIVERABILITY_SURFACE_KEYS = [
  "summary",
  "history",
  "dns",
  "hits",
  "webhooks",
  "bounces",
] as const;

export type DeliverabilitySurfaceKey =
  (typeof DELIVERABILITY_SURFACE_KEYS)[number];

export type DeliverabilitySurfaceErrors = Partial<
  Record<DeliverabilitySurfaceKey, string>
>;

interface DeliverabilityHubSnapshot {
  identity: string | null;
  summary: DeliverabilityHubSummary | null;
  history: DeliverabilityHubHistoryResponse | null;
  dns: DnsHealthStatus[] | null;
  hits: BlocklistHit[] | null;
  webhookErrors: WebhookErrorRow[] | null;
  bounces: BounceClassBreakdownResponse | null;
  errors: DeliverabilitySurfaceErrors;
  loading: boolean;
  refreshCompletedAt: number | null;
}

export interface DeliverabilityHubData extends DeliverabilityHubSnapshot {
  identityPending: boolean;
  initialLoading: boolean;
  refresh: () => Promise<void>;
}

export function deliverabilityRefreshReceipt(
  data: Pick<
    DeliverabilityHubData,
    "errors" | "identityPending" | "loading" | "refreshCompletedAt"
  >,
): string {
  if (data.identityPending) return "Resolving workspace identity";
  if (data.loading) return "Verifying six evidence surfaces";
  if (data.refreshCompletedAt === null) return "Refresh not yet completed";

  const failed = DELIVERABILITY_SURFACE_KEYS.filter(
    (surface) => data.errors[surface] !== undefined,
  ).length;
  const verified = DELIVERABILITY_SURFACE_KEYS.length - failed;
  const completedAt = new Date(data.refreshCompletedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (failed === 0) {
    return `All 6 evidence surfaces verified at ${completedAt}`;
  }
  if (verified === 0) {
    return `Refresh failed at ${completedAt} · 0 of 6 surfaces verified`;
  }
  return `Partial refresh at ${completedAt} · ${verified} of 6 surfaces verified`;
}

interface ContainedRead<T> {
  data: T | null;
  error: string | null;
}

const SENSITIVE_ERROR_PATTERN =
  /authorization|bearer|password|secret|token|sqlstate|postgres|stack trace|https?:\/\/|\bselect\b|\binsert\b|\bupdate\b/iu;

function emptySnapshot(
  identity: string | null,
  loading = identity !== null,
): DeliverabilityHubSnapshot {
  return {
    identity,
    summary: null,
    history: null,
    dns: null,
    hits: null,
    webhookErrors: null,
    bounces: null,
    errors: {},
    loading,
    refreshCompletedAt: null,
  };
}

function safeErrorMessage(value: unknown, fallback: string): string {
  const candidate =
    value instanceof Error
      ? value.message
      : typeof value === "object" &&
          value !== null &&
          "message" in value &&
          typeof value.message === "string"
        ? value.message
        : "";
  const normalized = candidate.replace(/\s+/gu, " ").trim();
  if (
    normalized.length === 0 ||
    normalized.length > 240 ||
    SENSITIVE_ERROR_PATTERN.test(normalized)
  ) {
    return fallback;
  }
  return normalized;
}

function containRead<T>(
  settlement: PromiseSettledResult<unknown>,
  parse: (value: unknown) => T | null,
  fallback: string,
): ContainedRead<T> {
  if (settlement.status === "rejected") {
    return {
      data: null,
      error: safeErrorMessage(settlement.reason, fallback),
    };
  }
  const value = settlement.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { data: null, error: fallback };
  }
  const result = value as Record<string, unknown>;
  if (result.error !== undefined && result.error !== null) {
    return {
      data: null,
      error: safeErrorMessage(result.error, fallback),
    };
  }
  const parsed = parse(result.data);
  return parsed === null
    ? { data: null, error: fallback }
    : { data: parsed, error: null };
}

function errorMap(
  reads: Record<DeliverabilitySurfaceKey, ContainedRead<unknown>>,
): DeliverabilitySurfaceErrors {
  const errors: DeliverabilitySurfaceErrors = {};
  for (const [key, read] of Object.entries(reads) as Array<
    [DeliverabilitySurfaceKey, ContainedRead<unknown>]
  >) {
    if (read.error !== null) errors[key] = read.error;
  }
  return errors;
}

export function useDeliverabilityHubData(): DeliverabilityHubData {
  const me = useMe();
  const identity = me ? `${me.user}\u001f${me.tenant}` : null;
  const [snapshot, setSnapshot] = useState<DeliverabilityHubSnapshot>(() =>
    emptySnapshot(identity),
  );
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    if (identity === null || !mountedRef.current) return;
    const request = ++requestRef.current;
    setSnapshot((current) =>
      current.identity === identity
        ? { ...current, loading: true }
        : emptySnapshot(identity),
    );
    const settlements = await Promise.allSettled([
      deliverabilityHubApi.get(),
      deliverabilityHubApi.history(),
      deliverabilityHubApi.dnsHealth(),
      deliverabilityHubApi.blocklistHits(),
      deliverabilityHubApi.webhookErrors(),
      deliverabilityHubApi.bounceClassBreakdown(),
    ]);
    if (!mountedRef.current || request !== requestRef.current) return;

    const [summary, history, dns, hits, webhooks, bounces] = [
      containRead(
        settlements[0]!,
        parseDeliverabilitySummary,
        "The current score could not be verified.",
      ),
      containRead(
        settlements[1]!,
        parseDeliverabilityHistory,
        "Score history could not be verified.",
      ),
      containRead(
        settlements[2]!,
        parseDnsHealthRows,
        "DNS health could not be verified.",
      ),
      containRead(
        settlements[3]!,
        parseBlocklistHits,
        "Blocklist observations could not be verified.",
      ),
      containRead(
        settlements[4]!,
        parseWebhookErrors,
        "Webhook failures could not be verified.",
      ),
      containRead(
        settlements[5]!,
        parseBounceClassBreakdown,
        "Bounce classes could not be verified.",
      ),
    ] as const;
    const reads: Record<DeliverabilitySurfaceKey, ContainedRead<unknown>> = {
      summary,
      history,
      dns,
      hits,
      webhooks,
      bounces,
    };

    setSnapshot((current) => {
      if (current.identity !== identity) return current;
      return {
        identity,
        summary: summary.data ?? current.summary,
        history: history.data ?? current.history,
        dns: dns.data ?? current.dns,
        hits: hits.data ?? current.hits,
        webhookErrors: webhooks.data ?? current.webhookErrors,
        bounces: bounces.data ?? current.bounces,
        errors: errorMap(reads),
        loading: false,
        refreshCompletedAt: Date.now(),
      };
    });
  }, [identity]);

  useEffect(() => {
    mountedRef.current = true;
    requestRef.current += 1;
    setSnapshot(emptySnapshot(identity));
    if (identity !== null) void refresh();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, [identity, refresh]);

  const current =
    snapshot.identity === identity ? snapshot : emptySnapshot(identity);
  return {
    ...current,
    identityPending: identity === null,
    initialLoading:
      current.loading &&
      current.summary === null &&
      current.history === null &&
      current.dns === null &&
      current.hits === null &&
      current.webhookErrors === null &&
      current.bounces === null,
    refresh,
  };
}
