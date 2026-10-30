import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type HistoryEntry,
  recordHistoryEntry,
} from "../components/playground/PlaygroundHistory";
import { generateIdempotencyKey } from "../components/playground/PlaygroundHeaders";
import { toast } from "../components/Toast";
import { registerLifecycleGuard } from "../lib/lifecycle-coordinator";
import type { NormalizedPlaygroundOperation } from "./api-playground-openapi";
import {
  type PlaygroundExecutionPolicy,
  executionPolicyFor,
  playgroundRoleAllows,
} from "./api-playground-policy";
import {
  PLAYGROUND_HEADER_VALUE_MAX_BYTES,
  PLAYGROUND_PATH_VALUE_MAX_BYTES,
  PLAYGROUND_QUERY_MAX_BYTES,
  PLAYGROUND_REQUEST_BODY_MAX_BYTES,
  type BuiltPlaygroundRequest,
  type PlaygroundRequestValues,
  buildPlaygroundRequest,
  firstIssueMessage,
} from "./api-playground-request";
import {
  type PlaygroundTransportResponse,
  executePlaygroundRequest,
} from "./api-playground-transport";

export interface PlaygroundDraft extends PlaygroundRequestValues {
  touched: boolean;
}

export interface PlaygroundReviewSnapshot {
  operation: NormalizedPlaygroundOperation;
  policy: PlaygroundExecutionPolicy;
  request: BuiltPlaygroundRequest;
  bodyBytes: number;
  values: PlaygroundDraft;
}

export interface PlaygroundWorkbenchController {
  selectedKey: string;
  selected: NormalizedPlaygroundOperation;
  select: (key: string) => void;
  draft: PlaygroundDraft;
  updateDraft: (patch: Partial<PlaygroundDraft>) => void;
  updateDraftMap: (
    field: "path" | "query" | "headers",
    name: string,
    value: string,
  ) => void;
  request: BuiltPlaygroundRequest;
  policy: PlaygroundExecutionPolicy;
  response: PlaygroundTransportResponse | null;
  sending: boolean;
  review: PlaygroundReviewSnapshot | null;
  setReview: (value: PlaygroundReviewSnapshot | null) => void;
  requestSend: () => Promise<void>;
  confirmSend: () => Promise<void>;
  cancel: () => void;
  newAttempt: () => void;
  replay: (entry: HistoryEntry) => void;
}

export function playgroundRequiresVerifiedStateBeforeRetry(
  response: PlaygroundTransportResponse | null,
  policy: PlaygroundExecutionPolicy,
): boolean {
  return response?.ambiguous === true && policy.idempotency === "none";
}

function operationKey(operation: NormalizedPlaygroundOperation): string {
  return `${operation.method.toUpperCase()} ${operation.path}`;
}

function idempotencyKeyForPlan(
  plan: BuiltPlaygroundRequest["plan"],
): string | null {
  const entry = Object.entries(plan.headers).find(
    ([name]) => name.toLowerCase() === "idempotency-key",
  );
  return entry?.[1]?.trim() || null;
}

function exactPlanBinding(plan: BuiltPlaygroundRequest["plan"]): string {
  return JSON.stringify([
    plan.method,
    plan.url,
    Object.entries(plan.headers),
    plan.body,
    plan.bodyIsJSON,
    plan.authMode,
  ]);
}

const IDEMPOTENCY_BINDING_MESSAGE =
  "This Idempotency-Key is already bound to a different exact request. Choose New attempt or regenerate the key before review.";

function parameterExample(
  operation: NormalizedPlaygroundOperation,
  location: "path" | "query" | "header",
): Record<string, string> {
  const values: Record<string, string> = {};
  const encodedQuery = new URLSearchParams();
  for (const parameter of operation.parameters.filter(
    (item) => item.location === location,
  )) {
    const schema = parameter.schema;
    const value =
      parameter.example ??
      schema?.example ??
      schema?.default ??
      (Array.isArray(schema?.enum) ? schema.enum[0] : undefined);
    if (
      value === undefined ||
      value === null ||
      (typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean")
    ) {
      continue;
    }
    const serialized = String(value);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (
      (location === "path" && bytes > PLAYGROUND_PATH_VALUE_MAX_BYTES) ||
      (location === "header" && bytes > PLAYGROUND_HEADER_VALUE_MAX_BYTES)
    ) {
      continue;
    }
    if (location === "query") {
      encodedQuery.set(parameter.name, serialized);
      if (
        new TextEncoder().encode(encodedQuery.toString()).byteLength >
        PLAYGROUND_QUERY_MAX_BYTES
      ) {
        encodedQuery.delete(parameter.name);
        continue;
      }
    }
    values[parameter.name] = serialized;
  }
  return values;
}

function initialDraft(
  operation: NormalizedPlaygroundOperation,
): PlaygroundDraft {
  const policy = executionPolicyFor(operation);
  let body = "";
  if (operation.requestBody?.example !== undefined) {
    try {
      body = JSON.stringify(operation.requestBody.example, null, 2);
      if (
        new TextEncoder().encode(body).byteLength >
        PLAYGROUND_REQUEST_BODY_MAX_BYTES
      ) {
        body = "";
      }
    } catch {
      body = "";
    }
  }
  return {
    path: parameterExample(operation, "path"),
    query: parameterExample(operation, "query"),
    headers: parameterExample(operation, "header"),
    customHeaders: [],
    body,
    idempotencyKey:
      policy.idempotency === "none" ? "" : generateIdempotencyKey(),
    touched: false,
  };
}

function replayDraft(
  operation: NormalizedPlaygroundOperation,
): PlaygroundDraft {
  const policy = executionPolicyFor(operation);
  return {
    path: {},
    query: {},
    headers: {},
    customHeaders: [],
    body: "",
    idempotencyKey:
      policy.idempotency === "none" ? "" : generateIdempotencyKey(),
    touched: false,
  };
}

type PlaygroundResponses = Record<string, PlaygroundTransportResponse | null>;

function usePlaygroundRequestExecution({
  apiURL,
  historyScope,
  setResponses,
}: {
  apiURL: string;
  historyScope: string | null;
  setResponses: Dispatch<SetStateAction<PlaygroundResponses>>;
}) {
  const [sendingKey, setSendingKey] = useState<string | null>(null);
  const attemptedPlans = useRef(new Map<string, string>());
  const [attemptRevision, setAttemptRevision] = useState(0);
  const activeRequest = useRef<{
    key: string;
    abort: AbortController;
    effect: PlaygroundExecutionPolicy["effect"];
  } | null>(null);

  const retainAttempt = useCallback(
    async (
      operation: NormalizedPlaygroundOperation,
      response: PlaygroundTransportResponse,
      values: PlaygroundDraft,
    ): Promise<void> => {
      try {
        await recordHistoryEntry(historyScope, {
          method: operation.method.toUpperCase() as HistoryEntry["method"],
          pathTemplate: operation.path,
          status: response.status,
          durationMs: response.durationMs,
          outcome: response.outcome,
          ambiguous: response.ambiguous,
          parameterNamesOmitted: {
            path: operation.parameters
              .filter((parameter) => parameter.location === "path")
              .map((parameter) => parameter.name),
            query: operation.parameters
              .filter((parameter) => parameter.location === "query")
              .map((parameter) => parameter.name),
            header: operation.parameters
              .filter((parameter) => parameter.location === "header")
              .map((parameter) => parameter.name),
          },
          customHeaderNamesOmitted: values.customHeaders
            .map((row) => row.key.trim())
            .filter(Boolean),
          body: "",
          bodyOmitted: Boolean(values.body.trim()),
        });
      } catch {
        toast.error({
          message: "Request completed, but history was not saved",
          detail:
            "Encrypted device storage is unavailable. No plaintext fallback was created.",
        });
      }
    },
    [historyScope],
  );

  const execute = useCallback(
    async (snapshot: PlaygroundReviewSnapshot): Promise<void> => {
      if (activeRequest.current) return;
      if (snapshot.policy.effect !== "read") {
        const idempotencyKey = idempotencyKeyForPlan(snapshot.request.plan);
        if (idempotencyKey) {
          const binding = exactPlanBinding(snapshot.request.plan);
          const attempted = attemptedPlans.current.get(idempotencyKey);
          if (attempted && attempted !== binding) {
            toast.error({
              message: "Idempotency-Key cannot be reused",
              detail: IDEMPOTENCY_BINDING_MESSAGE,
            });
            return;
          }
          if (!attempted) {
            attemptedPlans.current.set(idempotencyKey, binding);
            setAttemptRevision((current) => current + 1);
          }
        }
      }
      const key = operationKey(snapshot.operation);
      const abort = new AbortController();
      activeRequest.current = { key, abort, effect: snapshot.policy.effect };
      setSendingKey(key);
      try {
        const response = await executePlaygroundRequest(
          apiURL,
          snapshot.request.plan,
          snapshot.policy,
          abort.signal,
        );
        setResponses((current) => ({ ...current, [key]: response }));
        await retainAttempt(snapshot.operation, response, snapshot.values);
      } finally {
        if (activeRequest.current?.abort === abort)
          activeRequest.current = null;
        setSendingKey((current) => (current === key ? null : current));
      }
    },
    [apiURL, retainAttempt, setResponses],
  );

  const cancel = useCallback((): void => {
    activeRequest.current?.abort.abort("operator-cancelled");
  }, []);

  return {
    activeRequest,
    attemptedPlans,
    attemptRevision,
    cancel,
    execute,
    sendingKey,
  };
}

function usePlaygroundWorkbenchLifecycleGuard(
  anyDirty: boolean,
  sendingKey: string | null,
  setDrafts: Dispatch<SetStateAction<Record<string, PlaygroundDraft>>>,
): void {
  useEffect(() => {
    if (!anyDirty && !sendingKey) return;
    return registerLifecycleGuard({
      id: "api-playground-workbench",
      label: "API Playground workbench",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : sendingKey
            ? {
                level: "blocking",
                detail:
                  "An API Playground request is still in flight. Cancel it before leaving.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail:
                  "One or more in-memory request drafts have unsaved values.",
              },
      discard: () => setDrafts({}),
    });
  }, [anyDirty, sendingKey, setDrafts]);
}

export function usePlaygroundWorkbenchController({
  operations,
  apiURL,
  historyScope,
  effectiveRole,
}: {
  operations: NormalizedPlaygroundOperation[];
  apiURL: string;
  historyScope: string | null;
  effectiveRole: string | null;
}): PlaygroundWorkbenchController {
  const byKey = useMemo(
    () =>
      new Map(
        operations.map((operation) => [operationKey(operation), operation]),
      ),
    [operations],
  );
  const firstExecutable =
    operations.find((operation) => executionPolicyFor(operation).executable) ??
    operations[0]!;
  const firstKey = operationKey(firstExecutable);
  const [selectedKey, setSelectedKey] = useState(firstKey);
  const selected = byKey.get(selectedKey) ?? firstExecutable;
  const [drafts, setDrafts] = useState<Record<string, PlaygroundDraft>>(() => ({
    [firstKey]: initialDraft(firstExecutable),
  }));
  const [responses, setResponses] = useState<PlaygroundResponses>({});
  const [review, setReview] = useState<PlaygroundReviewSnapshot | null>(null);
  const {
    activeRequest,
    attemptedPlans,
    attemptRevision,
    cancel,
    execute,
    sendingKey,
  } = usePlaygroundRequestExecution({ apiURL, historyScope, setResponses });
  const draft = useMemo(
    () => drafts[selectedKey] ?? initialDraft(selected),
    [drafts, selected, selectedKey],
  );
  const policy = useMemo(() => executionPolicyFor(selected), [selected]);
  const builtRequest = useMemo(
    () => buildPlaygroundRequest(apiURL, selected, policy, draft),
    [apiURL, draft, policy, selected],
  );
  const request = useMemo((): BuiltPlaygroundRequest => {
    void attemptRevision;
    if (policy.effect === "read") return builtRequest;
    const idempotencyKey = idempotencyKeyForPlan(builtRequest.plan);
    const attempted = idempotencyKey
      ? attemptedPlans.current.get(idempotencyKey)
      : undefined;
    if (!attempted || attempted === exactPlanBinding(builtRequest.plan)) {
      return builtRequest;
    }
    return {
      ...builtRequest,
      plan: Object.freeze({
        ...builtRequest.plan,
        snippetAllowed: false,
        snippetUnavailableReason: IDEMPOTENCY_BINDING_MESSAGE,
      }),
      issues: [
        ...builtRequest.issues,
        {
          field: "header",
          name: "Idempotency-Key",
          message: IDEMPOTENCY_BINDING_MESSAGE,
        },
      ],
    };
  }, [attemptRevision, builtRequest, policy.effect]);

  const updateDraft = useCallback(
    (patch: Partial<PlaygroundDraft>): void => {
      setDrafts((current) => ({
        ...current,
        [selectedKey]: {
          ...(current[selectedKey] ?? draft),
          ...patch,
          touched: true,
        },
      }));
    },
    [draft, selectedKey],
  );

  const updateDraftMap = useCallback(
    (
      field: "path" | "query" | "headers",
      name: string,
      value: string,
    ): void => {
      setDrafts((current) => {
        const existing = current[selectedKey] ?? draft;
        return {
          ...current,
          [selectedKey]: {
            ...existing,
            [field]: { ...existing[field], [name]: value },
            touched: true,
          },
        };
      });
    },
    [draft, selectedKey],
  );

  const requestSend = useCallback(async (): Promise<void> => {
    if (activeRequest.current) return;
    if (!historyScope) {
      toast.error({
        message: "Workspace identity is unresolved",
        detail:
          "Live execution stays disabled until the exact API authority, tenant, and principal are known.",
      });
      return;
    }
    if (
      playgroundRequiresVerifiedStateBeforeRetry(
        responses[selectedKey] ?? null,
        policy,
      )
    ) {
      toast.error({
        message: "Verify the prior mutation before another attempt",
        detail:
          "The prior outcome is unknown and this operation has no idempotency contract. Verify server state, then choose “I verified state · New attempt” explicitly.",
      });
      return;
    }
    const message = firstIssueMessage(request.issues);
    if (message) {
      toast.error({ message: "Request is not ready", detail: message });
      return;
    }
    if (!playgroundRoleAllows(effectiveRole, policy.requiredRole)) {
      toast.error({
        message: `${policy.requiredRole} authority required`,
        detail:
          "The server remains authoritative; switch out of viewer preview or use a permitted credential.",
      });
      return;
    }
    const snapshot: PlaygroundReviewSnapshot = {
      operation: selected,
      policy,
      request,
      bodyBytes: new TextEncoder().encode(request.plan.body).byteLength,
      values: draft,
    };
    if (policy.effect === "read") await execute(snapshot);
    else setReview(snapshot);
  }, [
    draft,
    effectiveRole,
    execute,
    historyScope,
    policy,
    request,
    responses,
    selected,
    selectedKey,
  ]);

  const confirmSend = useCallback(async (): Promise<void> => {
    const snapshot = review;
    if (!snapshot) return;
    if (
      !historyScope ||
      !playgroundRoleAllows(effectiveRole, snapshot.policy.requiredRole)
    ) {
      setReview(null);
      toast.error({
        message: "Request authority changed",
        detail:
          "The exact workspace or role authority is no longer available. Re-open review after authority is resolved.",
      });
      return;
    }
    setReview(null);
    await execute(snapshot);
  }, [effectiveRole, execute, historyScope, review]);

  const select = useCallback(
    (key: string): void => {
      if (activeRequest.current) {
        toast.info("Cancel the in-flight request before changing operations.");
        return;
      }
      const operation = byKey.get(key);
      if (!operation) return;
      const seed = initialDraft(operation);
      setReview(null);
      setDrafts((current) =>
        current[key] ? current : { ...current, [key]: seed },
      );
      setSelectedKey(key);
    },
    [byKey],
  );

  const newAttempt = useCallback((): void => {
    const existing = drafts[selectedKey] ?? draft;
    setDrafts((current) => ({
      ...current,
      [selectedKey]: {
        ...existing,
        idempotencyKey:
          policy.idempotency === "none" ? "" : generateIdempotencyKey(),
        touched: existing.touched,
      },
    }));
    setResponses((current) => ({ ...current, [selectedKey]: null }));
  }, [draft, drafts, policy.idempotency, selectedKey]);

  const replay = useCallback(
    (entry: HistoryEntry): void => {
      if (activeRequest.current) {
        toast.info(
          "Cancel the in-flight request before opening a replay draft.",
        );
        return;
      }
      const key = `${entry.method} ${entry.pathTemplate}`;
      const operation = byKey.get(key);
      if (!operation) {
        toast.error("This historical operation is no longer in the catalog.");
        return;
      }
      const nextDraft = replayDraft(operation);
      setSelectedKey(key);
      setReview(null);
      setResponses((current) => ({ ...current, [key]: null }));
      setDrafts((current) => ({ ...current, [key]: nextDraft }));
      toast.info({
        message: "Safe replay draft opened",
        detail:
          "Parameter values, bodies, and header values are private and must be re-entered.",
      });
    },
    [byKey],
  );

  const anyDirty = Object.values(drafts).some((item) => item.touched);
  usePlaygroundWorkbenchLifecycleGuard(anyDirty, sendingKey, setDrafts);

  useEffect(
    () => () => {
      const active = activeRequest.current;
      if (!active) return;
      active.abort.abort("workbench-unmounted");
      if (active.effect !== "read") {
        toast.info({
          message: "Mutation outcome may be unknown",
          detail:
            "Authority changed while the request was in flight. Verify server state before retrying; reuse the same key only for the exact same request.",
        });
      }
    },
    [],
  );

  return {
    selectedKey,
    selected,
    select,
    draft,
    updateDraft,
    updateDraftMap,
    request,
    policy,
    response: responses[selectedKey] ?? null,
    sending: sendingKey !== null,
    review,
    setReview,
    requestSend,
    confirmSend,
    cancel,
    newAttempt,
    replay,
  };
}
