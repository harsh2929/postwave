import { useEffect, useRef, useState } from "react";

import type { SubscriberMutationHint } from "../../components/SubscriberDetailSlideover";
import type { SubscriberStatusConsentTarget } from "../../components/subscribers/SubscriberStatusConsentModal";
import {
  engineStatusToUi,
  uiStatusToEngine,
} from "../../components/subscribers/subscriber-status";
import { toast } from "../../components/Toast";
import {
  type Subscriber,
  type SubscriberDetail,
  api,
} from "../../lib/api-client";
import { queueReceiptMessage } from "../../lib/api/result";
import { applySubscriberMutationHint } from "./apply-subscriber-mutation-hint";
import { requireSubscriberVersion } from "./subscriber-mutation-version";
import { subscriberKey } from "./subscribers-page-utils";
import { useSubscriberEmailMutation } from "./useSubscriberEmailMutation";
import type { SubscribersData } from "./useSubscribersData";
import type { SubscribersPageState } from "./useSubscribersPageState";

export function useSubscriberRowMutations(
  state: SubscribersPageState,
  data: SubscribersData,
  onAudienceMutation: () => void = () => undefined,
  identityScope: string | null = null,
) {
  const [statusConsentTarget, setStatusConsentTarget] =
    useState<SubscriberStatusConsentTarget | null>(null);
  const identityRef = useRef(identityScope);
  const statusConsentIdentityRef = useRef<string | null>(null);
  identityRef.current = identityScope;
  useEffect(() => {
    statusConsentIdentityRef.current = null;
    setStatusConsentTarget(null);
  }, [identityScope]);
  const patchRowOptimistic = async (
    row: Subscriber,
    patch: { status?: string; tags?: string[] },
    label: string,
  ): Promise<void> => {
    if (row.id == null) {
      toast.error(`Can't update ${label}: missing id`);
      return;
    }
    const version = requireSubscriberVersion(
      row,
      `Can't update ${label} until this subscriber is refreshed with its latest revision.`,
    );
    if (!version) return;
    onAudienceMutation();
    const ownerIdentity = identityRef.current;
    const key = subscriberKey(row);
    const mutationToken = data.beginOptimisticRowMutation(key);
    let previousRow: Subscriber | undefined;
    data.setRows((current) => {
      if (!current) return current;
      return current.map((item) => {
        if (subscriberKey(item) !== key) return item;
        previousRow ??= item;
        return { ...item, ...patch };
      });
    });
    if (state.selected && subscriberKey(state.selected) === key) {
      state.setSelected({ ...state.selected, ...patch });
    }
    let response: Awaited<ReturnType<typeof api.updateSubscriber>>;
    try {
      response = await api.updateSubscriber(row.id, patch, { version });
    } catch (error) {
      if (ownerIdentity !== identityRef.current) {
        data.finishOptimisticRowMutation(mutationToken);
        return;
      }
      const rollback: Partial<Subscriber> = {};
      if (patch.status !== undefined) rollback.status = previousRow?.status;
      if (patch.tags !== undefined) rollback.tags = previousRow?.tags;
      data.setRows(
        (current) =>
          current?.map((item) =>
            subscriberKey(item) === key ? { ...item, ...rollback } : item,
          ) ?? current,
      );
      state.setSelected((selected) =>
        selected && subscriberKey(selected) === key
          ? { ...selected, ...rollback }
          : selected,
      );
      data.finishOptimisticRowMutation(mutationToken);
      toast.error(
        `Couldn't update ${label}: ${error instanceof Error ? error.message : "The request failed before the server confirmed it."}`,
      );
      return;
    }
    if (ownerIdentity !== identityRef.current) {
      data.finishOptimisticRowMutation(mutationToken);
      return;
    }
    if (response.queued) {
      data.finishOptimisticRowMutation(mutationToken);
      toast.info(queueReceiptMessage(response.receipt));
      return;
    }
    if (!response.error) {
      data.setRows(
        (current) =>
          current?.map((item) =>
            subscriberKey(item) === key ? { ...item, ...response.data } : item,
          ) ?? current,
      );
      state.setSelected((selected) =>
        selected && subscriberKey(selected) === key
          ? { ...selected, ...response.data }
          : selected,
      );
      data.finishOptimisticRowMutation(mutationToken);
      return;
    }
    const rollback: Partial<Subscriber> = {};
    if (patch.status !== undefined) rollback.status = previousRow?.status;
    if (patch.tags !== undefined) rollback.tags = previousRow?.tags;
    data.setRows((current) => {
      if (!current) return current;
      return current.map((item) =>
        subscriberKey(item) === key ? { ...item, ...rollback } : item,
      );
    });
    state.setSelected((selected) =>
      selected && subscriberKey(selected) === key
        ? { ...selected, ...rollback }
        : selected,
    );
    data.finishOptimisticRowMutation(mutationToken);
    toast.error(`Couldn't update ${label}: ${response.error.message}`);
  };

  const setRowStatus = (row: Subscriber, status: string): void => {
    const engineStatus = uiStatusToEngine(status);
    if (engineStatus == null) {
      toast.error(
        "This subscriber has an unrecognized status. Reconcile the source value before changing send eligibility.",
      );
      return;
    }
    if (engineStatus === "enabled") {
      if (engineStatusToUi(row.status) === "subscribed") return;
      if (row.id == null) {
        toast.error("Can't review this consent grant: missing subscriber id");
        return;
      }
      const version = requireSubscriberVersion(
        row,
        "Refresh this subscriber before recording consent so the latest revision can be verified.",
      );
      if (!version) return;
      statusConsentIdentityRef.current = identityRef.current;
      setStatusConsentTarget({ ...row, id: row.id, version });
      return;
    }
    void patchRowOptimistic(row, { status: engineStatus }, "status");
  };

  const applyEnabledSubscriber = (updated: SubscriberDetail): void => {
    const target = statusConsentTarget;
    if (!target || statusConsentIdentityRef.current !== identityRef.current) {
      setStatusConsentTarget(null);
      return;
    }
    const key = subscriberKey(target);
    onAudienceMutation();
    data.markLocalRowMutation(key);
    data.setRows((current) =>
      current
        ? current.map((row) =>
            subscriberKey(row) === key ? { ...row, ...updated } : row,
          )
        : current,
    );
    state.setSelected((selected) =>
      selected && subscriberKey(selected) === key
        ? { ...selected, ...updated }
        : selected,
    );
    statusConsentIdentityRef.current = null;
    setStatusConsentTarget(null);
  };
  const addTagToRow = (row: Subscriber, tag: string): void => {
    const existing = row.tags ?? [];
    if (existing.includes(tag)) return;
    void patchRowOptimistic(row, { tags: [...existing, tag] }, `tag "${tag}"`);
  };
  const removeTagFromRow = (row: Subscriber, tag: string): void => {
    const existing = row.tags ?? [];
    void patchRowOptimistic(
      row,
      { tags: existing.filter((item) => item !== tag) },
      `tag "${tag}"`,
    );
  };

  const applyMutationHint = (
    selectedKey: string,
    updated: Subscriber | null,
    hint: SubscriberMutationHint,
  ): boolean =>
    applySubscriberMutationHint(
      state,
      data,
      onAudienceMutation,
      selectedKey,
      updated,
      hint,
    );
  const renameEmailWithUndo = useSubscriberEmailMutation(
    state,
    data,
    onAudienceMutation,
    identityScope,
  );

  return {
    statusConsentTarget,
    closeStatusConsentReview: () => {
      statusConsentIdentityRef.current = null;
      setStatusConsentTarget(null);
    },
    applyEnabledSubscriber,
    setRowStatus,
    addTagToRow,
    removeTagFromRow,
    applyMutationHint,
    renameEmailWithUndo,
  };
}

export type SubscriberRowMutations = ReturnType<
  typeof useSubscriberRowMutations
>;
