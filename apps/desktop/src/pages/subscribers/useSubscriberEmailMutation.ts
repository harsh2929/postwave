import { useRef } from "react";

import { toast } from "../../components/Toast";
import { type Subscriber, api } from "../../lib/api-client";
import { subscriberKey } from "./subscribers-page-utils";
import { requireSubscriberVersion } from "./subscriber-mutation-version";
import type { SubscribersData } from "./useSubscribersData";
import type { SubscribersPageState } from "./useSubscribersPageState";

export function useSubscriberEmailMutation(
  state: SubscribersPageState,
  data: SubscribersData,
  onAudienceMutation: () => void,
  identityScope: string | null,
): (row: Subscriber, nextEmail: string) => void {
  const identityRef = useRef(identityScope);
  identityRef.current = identityScope;

  const applyEmailPatch = async (
    id: string | number,
    key: string,
    nextEmail: string,
    previousEmail: string,
    version: string,
  ) => {
    onAudienceMutation();
    const ownerIdentity = identityRef.current;
    const mutationToken = data.beginOptimisticRowMutation(key);
    data.setRows((current) =>
      current
        ? current.map((row) =>
            subscriberKey(row) === key ? { ...row, email: nextEmail } : row,
          )
        : current,
    );
    state.setSelected((selected) =>
      selected && subscriberKey(selected) === key
        ? { ...selected, email: nextEmail }
        : selected,
    );
    let response: Awaited<ReturnType<typeof api.updateSubscriber>>;
    try {
      response = await api.updateSubscriber(
        id,
        { email: nextEmail },
        { version, requireOnline: true, maxAttempts: 1 },
      );
    } catch (error) {
      if (ownerIdentity !== identityRef.current) {
        data.finishOptimisticRowMutation(mutationToken);
        return null;
      }
      data.setRows((current) =>
        current
          ? current.map((row) =>
              subscriberKey(row) === key
                ? { ...row, email: previousEmail }
                : row,
            )
          : current,
      );
      state.setSelected((selected) =>
        selected && subscriberKey(selected) === key
          ? { ...selected, email: previousEmail }
          : selected,
      );
      data.finishOptimisticRowMutation(mutationToken);
      toast.error(
        `Couldn't rename email: ${error instanceof Error ? error.message : "The request failed before the server confirmed it."}`,
      );
      return null;
    }
    if (ownerIdentity !== identityRef.current) {
      data.finishOptimisticRowMutation(mutationToken);
      return null;
    }
    if (!response.queued && !response.error) {
      data.setRows(
        (current) =>
          current?.map((row) =>
            subscriberKey(row) === key ? { ...row, ...response.data } : row,
          ) ?? current,
      );
      state.setSelected((selected) =>
        selected && subscriberKey(selected) === key
          ? { ...selected, ...response.data }
          : selected,
      );
      data.finishOptimisticRowMutation(mutationToken);
      return response.data;
    }
    data.setRows((current) =>
      current
        ? current.map((row) =>
            subscriberKey(row) === key ? { ...row, email: previousEmail } : row,
          )
        : current,
    );
    state.setSelected((selected) =>
      selected && subscriberKey(selected) === key
        ? { ...selected, email: previousEmail }
        : selected,
    );
    data.finishOptimisticRowMutation(mutationToken);
    const message = response.queued
      ? "The email change was not confirmed online. Reconnect and try again."
      : response.error.message;
    toast.error(`Couldn't rename email: ${message}`);
    return null;
  };

  return (row: Subscriber, nextEmail: string): void => {
    if (row.id == null) {
      toast.error("Can't rename email: missing id");
      return;
    }
    const id = row.id;
    const key = subscriberKey(row);
    const previousEmail = row.email;
    const version = requireSubscriberVersion(
      row,
      "Refresh this subscriber before renaming the email so the latest revision can be verified.",
    );
    if (!version) return;
    void applyEmailPatch(id, key, nextEmail, previousEmail, version).then(
      (updated) => {
        if (!updated) return;
        toast.success({
          message: "Email updated",
          detail: `Now ${nextEmail}.`,
          action: {
            label: "Undo",
            onClick: () => {
              const undoVersion = updated.version?.trim();
              if (!undoVersion) {
                toast.error(
                  "Refresh this subscriber before undoing the email change.",
                );
                return;
              }
              void applyEmailPatch(
                id,
                key,
                previousEmail,
                nextEmail,
                undoVersion,
              ).then((undone) => {
                if (undone) toast.info(`Reverted to ${previousEmail}.`);
              });
            },
          },
        });
      },
    );
  };
}
