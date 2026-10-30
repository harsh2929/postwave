// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * The runner's state machine — desktop api-playground-workbench-state.ts,
 * narrowed to the web's single session credential.
 *
 *   select → draft → (read) send ─────────────┐
 *                   (write) review → confirm ─┴→ in flight ─(cancel)→ response
 *                                                   response → new attempt
 *
 * Invariants the page relies on:
 *   - One request in flight at a time; selection and replay are refused while
 *     it runs, so a late response can never land on a different operation.
 *   - A write never leaves without a review of the exact plan.
 *   - An Idempotency-Key, once sent, is bound to that exact plan. Editing the
 *     request afterwards requires "New attempt" (a fresh key), so a retry
 *     cannot silently reuse a key for a different request.
 *   - A write with no idempotency contract whose outcome is unknown (cancel,
 *     timeout, network loss, 408/429/5xx) cannot be re-sent until the operator
 *     explicitly says they verified server state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { AuthRole } from "@/lib/auth-api";
import {
  playgroundPolicyFor,
  playgroundRoleAllows,
  type PlaygroundOperation,
  type PlaygroundPolicy,
} from "@/lib/api-playground-catalog";
import type { PlaygroundHistoryEntry } from "@/lib/api-playground-storage";
import {
  blankPlaygroundDraft,
  buildPlaygroundRequest,
  executePlaygroundRequest,
  initialPlaygroundDraft,
  newPlaygroundIdempotencyKey,
  type BuiltPlaygroundRequest,
  type PlaygroundDraft,
  type PlaygroundResponse,
} from "@/lib/api-playground-transport";

export interface PlaygroundReview {
  operation: PlaygroundOperation;
  policy: PlaygroundPolicy;
  request: BuiltPlaygroundRequest;
}

export const IDEMPOTENCY_BINDING_MESSAGE =
  "This Idempotency-Key was already sent with a different exact request. Choose New attempt to mint a fresh key.";
export const VERIFY_BEFORE_RETRY_MESSAGE =
  "The previous outcome is unknown and this operation declares no idempotency. Verify server state, then choose “I verified state · New attempt”.";

function planBinding(plan: BuiltPlaygroundRequest["plan"]): string {
  return JSON.stringify([plan.method, plan.url, Object.entries(plan.headers), plan.body]);
}

export interface PlaygroundController {
  selected: PlaygroundOperation;
  policy: PlaygroundPolicy;
  draft: PlaygroundDraft;
  request: BuiltPlaygroundRequest;
  response: PlaygroundResponse | null;
  sending: boolean;
  review: PlaygroundReview | null;
  /** Why Send/Review is disabled right now, or null when it is ready. */
  blocker: string | null;
  roleAllowed: boolean;
  select: (key: string) => boolean;
  replay: (entry: PlaygroundHistoryEntry) => boolean;
  updateParameter: (field: "path" | "query" | "headers", name: string, value: string) => void;
  updateBody: (body: string) => void;
  formatBody: () => void;
  send: () => void;
  confirmReview: () => void;
  dismissReview: () => void;
  cancel: () => void;
  newAttempt: () => void;
}

export function usePlaygroundController({
  operations,
  role,
  onAttempt,
}: {
  operations: PlaygroundOperation[];
  role: AuthRole | null;
  onAttempt: (entry: Omit<PlaygroundHistoryEntry, "id" | "at">) => void;
}): PlaygroundController {
  const byKey = useMemo(
    () => new Map(operations.map((operation) => [operation.key, operation])),
    [operations],
  );
  const first = useMemo(
    () =>
      operations.find((operation) => {
        const policy = playgroundPolicyFor(operation);
        return policy.executable && policy.effect === "read";
      }) ?? operations[0]!,
    [operations],
  );
  const [selectedKey, setSelectedKey] = useState(first.key);
  const selected = byKey.get(selectedKey) ?? first;
  const policy = playgroundPolicyFor(selected);
  const [drafts, setDrafts] = useState<Record<string, PlaygroundDraft>>(() => ({
    [first.key]: initialPlaygroundDraft(first),
  }));
  const fallbackDraft = useMemo(() => initialPlaygroundDraft(selected), [selected]);
  const draft = drafts[selected.key] ?? fallbackDraft;
  const [responses, setResponses] = useState<Record<string, PlaygroundResponse | null>>({});
  const [review, setReview] = useState<PlaygroundReview | null>(null);
  const [sendingKey, setSendingKey] = useState<string | null>(null);
  /** Idempotency-Key → the exact plan it was first sent with. */
  const [boundKeys, setBoundKeys] = useState<Record<string, string>>({});
  const active = useRef<{ abort: AbortController; effect: PlaygroundPolicy["effect"] } | null>(null);
  const mounted = useRef(true);
  const onAttemptRef = useRef(onAttempt);
  onAttemptRef.current = onAttempt;

  const request = useMemo(
    () => buildPlaygroundRequest(selected, policy, draft),
    [draft, policy, selected],
  );
  const response = responses[selected.key] ?? null;
  const roleAllowed = playgroundRoleAllows(role, policy.requiredRole);
  const idempotencyKey = request.plan.headers["Idempotency-Key"];
  const boundTo = idempotencyKey ? boundKeys[idempotencyKey] : undefined;

  const blocker: string | null = sendingKey
    ? "A request is in flight."
    : !policy.executable
      ? (policy.reason ?? "This operation is reference-only.")
      : role === null
        ? "Role authority is unresolved; live execution is disabled."
        : !roleAllowed
          ? `Your effective role (${role}) does not meet the ${policy.requiredRole} role this operation requires.`
          : request.issues.length > 0
            ? request.issues[0]!.message
            : response?.ambiguous && policy.idempotency === "none"
              ? VERIFY_BEFORE_RETRY_MESSAGE
              : boundTo !== undefined && boundTo !== planBinding(request.plan)
                ? IDEMPOTENCY_BINDING_MESSAGE
                : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = active.current;
      if (!current) return;
      current.abort.abort("playground-unmounted");
      if (current.effect !== "read") {
        toast.info("A playground write was still in flight when you left; verify server state before retrying.");
      }
    };
  }, []);

  const execute = useCallback(async (snapshot: PlaygroundReview) => {
    if (active.current) return;
    const key = snapshot.request.plan.headers["Idempotency-Key"];
    if (key) {
      const binding = planBinding(snapshot.request.plan);
      setBoundKeys((current) => (current[key] ? current : { ...current, [key]: binding }));
    }
    const abort = new AbortController();
    active.current = { abort, effect: snapshot.policy.effect };
    setSendingKey(snapshot.operation.key);
    try {
      const result = await executePlaygroundRequest(
        snapshot.request.plan,
        snapshot.policy,
        abort.signal,
      );
      if (!mounted.current) return;
      setResponses((current) => ({ ...current, [snapshot.operation.key]: result }));
      onAttemptRef.current({
        method: snapshot.request.plan.method,
        pathTemplate: snapshot.operation.path,
        status: result.status,
        durationMs: result.durationMs,
        outcome: result.outcome,
        ambiguous: result.ambiguous,
      });
    } finally {
      if (active.current?.abort === abort) active.current = null;
      if (mounted.current) setSendingKey(null);
    }
  }, []);

  const send = useCallback(() => {
    if (blocker) {
      toast.error(blocker);
      return;
    }
    const snapshot: PlaygroundReview = { operation: selected, policy, request };
    if (policy.effect === "read") void execute(snapshot);
    else setReview(snapshot);
  }, [blocker, execute, policy, request, selected]);

  const confirmReview = useCallback(() => {
    const snapshot = review;
    setReview(null);
    if (!snapshot) return;
    if (!playgroundRoleAllows(role, snapshot.policy.requiredRole)) {
      toast.error("Your role changed before the request was sent; nothing was sent.");
      return;
    }
    void execute(snapshot);
  }, [execute, review, role]);

  const select = useCallback(
    (key: string): boolean => {
      if (active.current) {
        toast.info("Cancel the in-flight request before changing operations.");
        return false;
      }
      const operation = byKey.get(key);
      if (!operation) return false;
      setReview(null);
      setDrafts((current) =>
        current[key] ? current : { ...current, [key]: initialPlaygroundDraft(operation) },
      );
      setSelectedKey(key);
      return true;
    },
    [byKey],
  );

  const replay = useCallback(
    (entry: PlaygroundHistoryEntry): boolean => {
      if (active.current) {
        toast.info("Cancel the in-flight request before opening a history draft.");
        return false;
      }
      const key = `${entry.method.toUpperCase()} ${entry.pathTemplate}`;
      if (!byKey.has(key)) {
        toast.error("That operation is no longer in the API contract.");
        return false;
      }
      setReview(null);
      setResponses((current) => ({ ...current, [key]: null }));
      setDrafts((current) => ({ ...current, [key]: blankPlaygroundDraft() }));
      setSelectedKey(key);
      toast.info("History keeps no values — re-enter parameters and body before sending.");
      return true;
    },
    [byKey],
  );

  const patchDraft = useCallback(
    (patch: (current: PlaygroundDraft) => PlaygroundDraft) => {
      setDrafts((current) => ({
        ...current,
        [selected.key]: patch(current[selected.key] ?? fallbackDraft),
      }));
    },
    [fallbackDraft, selected.key],
  );

  const updateParameter = useCallback(
    (field: "path" | "query" | "headers", name: string, value: string) => {
      patchDraft((current) => ({
        ...current,
        [field]: { ...current[field], [name]: value },
      }));
    },
    [patchDraft],
  );

  const updateBody = useCallback(
    (body: string) => patchDraft((current) => ({ ...current, body })),
    [patchDraft],
  );

  const formatBody = useCallback(() => {
    patchDraft((current) => {
      try {
        return { ...current, body: JSON.stringify(JSON.parse(current.body), null, 2) };
      } catch {
        // The inline issue already carries the parser's sentence.
        return current;
      }
    });
  }, [patchDraft]);

  const cancel = useCallback(() => {
    active.current?.abort.abort("operator-cancelled");
  }, []);

  const newAttempt = useCallback(() => {
    patchDraft((current) => ({ ...current, idempotencyKey: newPlaygroundIdempotencyKey() }));
    setResponses((current) => ({ ...current, [selected.key]: null }));
  }, [patchDraft, selected.key]);

  return {
    selected,
    policy,
    draft,
    request,
    response,
    sending: sendingKey !== null,
    review,
    blocker,
    roleAllowed,
    select,
    replay,
    updateParameter,
    updateBody,
    formatBody,
    send,
    confirmReview,
    dismissReview: () => setReview(null),
    cancel,
    newAttempt,
  };
}
