import type { ReactElement } from "react";

import type { CampaignTemplate, TemplateGoal } from "../../lib/api-client";
import type { CampaignTemplateSavedSearchFilters } from "../../lib/api/campaign-template-discovery";
import type { TemplateSource } from "./TemplateLibraryPrimitives";
import type {
  CampaignTemplateDiscoveryLifecycle,
  CampaignTemplateDiscoverySort,
} from "../../lib/campaign-template-discovery-preferences";

export interface DiscoveryFailure {
  code?: string;
  message: string;
  requestId?: string;
  status?: number;
}

export const TEMPLATE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestFailure(error: {
  code?: string;
  message: string;
  requestId?: string;
  status?: number;
}): DiscoveryFailure {
  if (error.status === 401 || error.code === "no_user") {
    return {
      ...error,
      message:
        "Your personal template library needs an authenticated user. Sign in again, then retry.",
    };
  }
  if (error.status === 403) {
    return {
      ...error,
      message:
        "Your current workspace permission does not include this personal library action.",
    };
  }
  if (error.status === 412 || error.code === "precondition_failed") {
    return {
      ...error,
      message:
        "This item changed elsewhere while you were reviewing it. The latest version must be loaded before you retry.",
    };
  }
  if (error.status === 428 || error.code === "precondition_required") {
    return {
      ...error,
      message:
        "The confirmed version is missing. Reload this item before making another change.",
    };
  }
  if (error.status === 409 || error.code === "name_conflict") {
    return {
      ...error,
      message:
        "You already have a personal library item with this name. Choose a different name.",
    };
  }
  return {
    ...error,
    message: error.message || "The request did not complete. Please retry.",
  };
}

export function failureDetail(failure: DiscoveryFailure): string {
  const references = [
    failure.code ? `Code ${failure.code}.` : "",
    failure.requestId ? `Request ${failure.requestId}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return references ? `${failure.message} ${references}` : failure.message;
}

export function isConcurrencyFailure(failure: DiscoveryFailure): boolean {
  return (
    failure.status === 412 ||
    failure.status === 428 ||
    failure.code === "precondition_failed" ||
    failure.code === "precondition_required"
  );
}

export function isMissingFailure(failure: DiscoveryFailure): boolean {
  return failure.status === 404;
}

export function isDeniedFailure(failure: DiscoveryFailure): boolean {
  return failure.status === 401 || failure.status === 403;
}

export function readableDate(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Invalid timestamp";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

export function templateLabel(
  id: string,
  templates: Map<string, CampaignTemplate>,
): string {
  return templates.get(id)?.name ?? `Template ${id}`;
}

export function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const existing = items.findIndex((candidate) => candidate.id === item.id);
  if (existing < 0) return [item, ...items];
  const next = [...items];
  next[existing] = item;
  return next;
}

export function currentSavedSearchFilters({
  currentGoal,
  currentQuery,
  currentSource,
  currentLifecycle,
  currentSort,
}: {
  currentGoal: TemplateGoal | "";
  currentQuery: string;
  currentSource: TemplateSource;
  currentLifecycle: CampaignTemplateDiscoveryLifecycle;
  currentSort: CampaignTemplateDiscoverySort;
}): CampaignTemplateSavedSearchFilters {
  const filters: CampaignTemplateSavedSearchFilters = {};
  const query = currentQuery.trim();
  if (query) filters.q = query;
  if (currentGoal) filters.goal = currentGoal;
  if (
    currentSource === "platform" ||
    currentSource === "team" ||
    currentSource === "mine"
  ) {
    filters.source = currentSource;
  } else if (currentSource === "favorited") {
    filters.favorited = true;
  }
  if (currentLifecycle !== "active") filters.archived = currentLifecycle;
  if (currentSort !== "recommended") filters.sort = currentSort;
  return filters;
}

export function savedSearchSummary(
  filters: CampaignTemplateSavedSearchFilters,
): string {
  const parts: string[] = [];
  if (filters.q) parts.push(`text “${filters.q}”`);
  if (filters.goal) parts.push(`goal ${filters.goal.replaceAll("_", " ")}`);
  if (filters.source) parts.push(`source ${filters.source}`);
  if (filters.favorited) parts.push("favorites only");
  if (filters.archived) parts.push(`archive ${filters.archived}`);
  if (filters.category) parts.push(`category ${filters.category}`);
  if (filters.provider) parts.push(`provider ${filters.provider}`);
  if (filters.industry) parts.push(`industry ${filters.industry}`);
  if (filters.style) parts.push(`style ${filters.style}`);
  if (filters.layout) parts.push(`layout ${filters.layout}`);
  if (filters.kind) parts.push(`kind ${filters.kind}`);
  if (filters.tags?.length) parts.push(`tags ${filters.tags.join(", ")}`);
  if (filters.featured) parts.push("featured only");
  if (filters.sort) parts.push(`sort ${filters.sort.replaceAll("_", " ")}`);
  return parts.length ? parts.join(" · ") : "All active templates";
}

export function ResourceTruth({
  count,
  label,
  lastVerifiedAt,
  loading,
  stale,
}: {
  count: number | null;
  label: string;
  lastVerifiedAt: number | null;
  loading: boolean;
  stale: boolean;
}): ReactElement {
  return (
    <div className="tpl-discovery-truth" aria-live="polite">
      <span>
        {count === null
          ? loading
            ? `Loading ${label}…`
            : `${label} unavailable`
          : `${count.toLocaleString()} ${label}`}
      </span>
      {stale ? <span>Showing the previous verified version.</span> : null}
      {lastVerifiedAt ? (
        <span>
          Last verified{" "}
          <time dateTime={new Date(lastVerifiedAt).toISOString()}>
            {readableDate(new Date(lastVerifiedAt).toISOString())}
          </time>
          .
        </span>
      ) : null}
    </div>
  );
}

export function FailureNotice({
  failure,
  loading,
  onRetry,
}: {
  failure: DiscoveryFailure | null;
  loading: boolean;
  onRetry?: () => void;
}): ReactElement | null {
  if (!failure) return null;
  return (
    <div className="notice tpl-discovery-notice" role="alert">
      <span>{failureDetail(failure)}</span>
      {onRetry ? (
        <button
          type="button"
          className="btn btn-sm"
          disabled={loading}
          onClick={onRetry}
        >
          {loading ? "Retrying…" : "Retry"}
        </button>
      ) : null}
    </div>
  );
}
