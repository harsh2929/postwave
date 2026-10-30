import type { Dispatch, SetStateAction } from "react";

import type {
  ApiResult,
  EmailValidationBatchResponse,
  List,
  Subscriber,
} from "../../lib/api-client";
import type { ConsentEvidenceDraft } from "./consent-evidence";
import { engineStatusToUi } from "./subscriber-status";

export interface BulkActionBarProps {
  selected: Subscriber[];
  onClear: () => void;
  rows?: Subscriber[];
  setRows?: Dispatch<SetStateAction<Subscriber[] | null>>;
  onDone: (skipReload?: boolean) => void;
  onOpenDedupeReview: () => void;
  canMutate: boolean;
}

export const BULK_MERGE_FIELDS = [
  "FNAME",
  "LNAME",
  "COMPANY",
  "ADDRESS",
  "PHONE",
  "ZIP",
  "CITY",
  "STATE",
  "COUNTRY",
] as const;

export const BULK_CONSENT_CATEGORIES: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "email_marketing", label: "Email marketing" },
  { value: "marketing", label: "Marketing (general)" },
  { value: "analytics", label: "Analytics" },
  { value: "email_tracking", label: "Email tracking" },
  { value: "sale_share", label: "Sale / share of data" },
  { value: "targeted_advertising", label: "Targeted advertising" },
  { value: "ai_processing", label: "AI processing" },
  { value: "sensitive_data", label: "Sensitive data" },
];

export interface BulkProgress {
  current: number;
  total: number;
  label: string;
  retrySeconds?: number;
  attempt?: number;
  maxAttempts?: number;
}

export interface BulkOutcome {
  tone: "info" | "warning" | "error";
  title: string;
  message: string;
  focusOnRender?: boolean;
  /** A frozen, reviewed scope owned by the failed operation. */
  retry?: {
    label: string;
    run: () => void;
  };
}

export type BulkListLoadStatus = "idle" | "loading" | "ready" | "error";

export type BulkBusy =
  | "tag"
  | "suppress"
  | "delete"
  | "merge"
  | "validate"
  | "resubscribe"
  | "addToList"
  | "customField"
  | "mergeField"
  | "grantConsent"
  | "revokeConsent"
  | "export"
  | null;

type StateSetter<T> = Dispatch<SetStateAction<T>>;

export interface BulkActionUiState {
  busy: BulkBusy;
  progress: BulkProgress | null;
  setProgress: StateSetter<BulkProgress | null>;
  outcome: BulkOutcome | null;
  setOutcome: StateSetter<BulkOutcome | null>;
  beginOperation: (
    kind: Exclude<BulkBusy, null>,
    progress: BulkProgress,
  ) => AbortSignal | null;
  finishOperation: (signal: AbortSignal) => void;
  cancelRetry: () => void;
  showTag: boolean;
  setShowTag: StateSetter<boolean>;
  tagInput: string;
  setTagInput: StateSetter<string>;
  showSuppress: boolean;
  setShowSuppress: StateSetter<boolean>;
  showDelete: boolean;
  setShowDelete: StateSetter<boolean>;
  validationResult: EmailValidationBatchResponse | null;
  setValidationResult: StateSetter<EmailValidationBatchResponse | null>;
  validationSkipped: number;
  setValidationSkipped: StateSetter<number>;
  showValidation: boolean;
  setShowValidation: StateSetter<boolean>;
  showLookalike: boolean;
  setShowLookalike: StateSetter<boolean>;
  showMore: boolean;
  setShowMore: StateSetter<boolean>;
  showResubscribe: boolean;
  setShowResubscribe: StateSetter<boolean>;
  showAddToList: boolean;
  setShowAddToList: StateSetter<boolean>;
  lists: List[];
  setLists: StateSetter<List[]>;
  listLoadStatus: BulkListLoadStatus;
  listLoadError: string | null;
  reloadLists: () => void;
  listId: string;
  setListId: StateSetter<string>;
  showCustomField: boolean;
  setShowCustomField: StateSetter<boolean>;
  cfKey: string;
  setCfKey: StateSetter<string>;
  cfValue: string;
  setCfValue: StateSetter<string>;
  showMergeField: boolean;
  setShowMergeField: StateSetter<boolean>;
  mfKey: string;
  setMfKey: StateSetter<string>;
  mfValue: string;
  setMfValue: StateSetter<string>;
  showConsent: null | "grant" | "revoke";
  setShowConsent: StateSetter<null | "grant" | "revoke">;
  consentCategory: string;
  setConsentCategory: StateSetter<string>;
  consentEvidence: ConsentEvidenceDraft;
  setConsentEvidence: StateSetter<ConsentEvidenceDraft>;
}

export interface BulkActionCallbacks {
  addTag: () => Promise<void>;
  suppress: () => Promise<void>;
  bulkDelete: () => Promise<void>;
  resubscribe: () => Promise<void>;
  addToList: () => Promise<void>;
  setCustomField: () => Promise<void>;
  updateMergeField: () => Promise<void>;
  applyConsent: (mode: "grant" | "revoke") => Promise<void>;
  exportCsv: (scope?: Subscriber[]) => Promise<void>;
  validateEmails: () => Promise<void>;
}

export function unwrapBulkLists(payload: unknown): List[] {
  const value = payload as
    | { data?: { results?: List[] } | List[]; results?: List[]; items?: List[] }
    | undefined;
  if (!value) return [];
  if (Array.isArray(value.data)) return value.data;
  if (value.data && Array.isArray(value.data.results)) {
    return value.data.results;
  }
  if (Array.isArray(value.results)) return value.results;
  if (Array.isArray(value.items)) return value.items;
  return [];
}

export function bulkRetryAfter(res: ApiResult<unknown>): number | undefined {
  if (!res.error) return undefined;
  const seconds = res.error.retryAfterSeconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return seconds;
  }
  if (res.error.status === 429) return 1;
  return undefined;
}

export function bulkSubscriberKey(subscriber: Subscriber): string {
  return String(subscriber.id ?? subscriber.email ?? "");
}

export function selectedSubscriberIds(selected: Subscriber[]): string[] {
  return selected.flatMap((subscriber) =>
    subscriber.id == null ? [] : [String(subscriber.id)],
  );
}

export interface ResubscribeEligibility {
  eligibleIds: string[];
  eligible: number;
  alreadySubscribed: number;
  ineligible: number;
  unknown: number;
  missingId: number;
}

/**
 * Conservative client preflight. Only recognisable blocklisted/unsubscribed
 * rows enter the request; the server independently excludes protected
 * complaints, erasures, bounces, and records that changed after selection.
 */
export function classifyResubscribeEligibility(
  selected: Subscriber[],
): ResubscribeEligibility {
  const out: ResubscribeEligibility = {
    eligibleIds: [],
    eligible: 0,
    alreadySubscribed: 0,
    ineligible: 0,
    unknown: 0,
    missingId: 0,
  };
  for (const subscriber of selected) {
    if (subscriber.id == null) {
      out.missingId += 1;
      continue;
    }
    const status = engineStatusToUi(subscriber.status);
    if (status === "unsubscribed") {
      out.eligibleIds.push(String(subscriber.id));
      out.eligible += 1;
    } else if (status === "subscribed") {
      out.alreadySubscribed += 1;
    } else if (status === "unknown") {
      out.unknown += 1;
    } else {
      out.ineligible += 1;
    }
  }
  return out;
}

export function parseBulkTags(input: string): string[] {
  return input
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function bulkBusyLabel(
  busy: BulkBusy,
  progress: BulkProgress | null,
  idle: string,
  working: string,
  kind: BulkBusy,
): string {
  if (busy !== kind) return idle;
  if (progress && progress.total > 1) {
    return `${working} ${progress.current}/${progress.total}…`;
  }
  return `${working}…`;
}
