// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  listSubscriberTopics,
  setSubscriberTopics,
  type SubscriberTopicView,
} from "@/lib/preferences-api";
import { base, STALE } from "@/lib/query-keys";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";

class TopicVerificationError extends Error {
  constructor() {
    super(
      "The preference update may have saved, but its final state could not be verified. Reload before trying again; do not repeat the change blindly.",
    );
    this.name = "TopicVerificationError";
  }
}

export function SubscriberPreferencesPanel({
  email,
  tenantId,
  role,
  authority,
  enabled,
}: {
  email: string;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority | null;
  enabled: boolean;
}) {
  const permissionReasonId = useId();
  const [pendingTopicId, setPendingTopicId] = useState<string | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const query = useQuery({
    queryKey: [...base("subscriber-topics", tenantId, role), email],
    queryFn: ({ signal }) => listSubscriberTopics(email, { signal }),
    enabled,
    staleTime: STALE.detail,
    retry: false,
  });

  useEffect(() => {
    generationRef.current += 1;
    operationRef.current?.abort();
    operationRef.current = null;
    setPendingTopicId(null);
  }, [authority?.role, authority?.tenantId, authority?.userId, email]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      operationRef.current?.abort();
    },
    [],
  );

  if (!enabled) return null;

  const update = async (
    row: SubscriberTopicView,
    optedIn: boolean,
  ): Promise<void> => {
    if (!authority || pendingTopicId !== null) return;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    operationRef.current?.abort();
    operationRef.current = controller;
    setPendingTopicId(row.topic.id);
    let committed = false;
    try {
      await reauthorizeSubscriberMutation(authority, controller.signal);
      await setSubscriberTopics(email, [{ topicId: row.topic.id, optedIn }], {
        signal: controller.signal,
      });
      committed = true;
      await reauthorizeSubscriberMutation(authority, controller.signal);
      const result = await query.refetch({ cancelRefetch: true });
      const verified = result.data?.find(
        (candidate) => candidate.topic.id === row.topic.id,
      );
      if (result.error || !verified || verified.optedIn !== optedIn) {
        throw new TopicVerificationError();
      }
      if (generation !== generationRef.current) return;
      toast.success(
        optedIn
          ? `Recorded an opt-in for “${row.topic.name}”.`
          : `Recorded an opt-out for “${row.topic.name}”.`,
      );
    } catch (error) {
      if (committed && !(error instanceof TopicVerificationError)) {
        void query.refetch();
        throw new TopicVerificationError();
      }
      throw error;
    } finally {
      if (generation === generationRef.current) {
        operationRef.current = null;
        setPendingTopicId(null);
      }
    }
  };

  if (query.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading preference topics…
      </p>
    );
  }
  if (query.isError && !query.data) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-destructive">
          Preference topics could not be verified. No empty or opt-out state is
          being inferred.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  }
  if (!query.data || query.data.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        This workspace has no preference-center topics configured.
      </p>
    );
  }

  return (
    <section className="space-y-4" aria-label="Subscriber topic preferences">
      {query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          The latest preference read failed. The choices below are the last
          verified state and may now be stale.
        </p>
      ) : null}
      <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
        These are administrative topic overrides. They do not create or restore
        email-marketing consent, remove a suppression, or make this subscriber
        eligible for sending.
      </div>
      <ul className="divide-y rounded-md border">
        {query.data.map((row) => {
          const next = !row.optedIn;
          const busy = pendingTopicId === row.topic.id;
          const disabled = pendingTopicId !== null || authority === null;
          return (
            <li
              key={row.topic.id}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="break-words text-sm font-medium">
                    {row.topic.name}
                  </p>
                  <Badge variant={row.optedIn ? "secondary" : "outline"}>
                    {row.optedIn ? "Opted in" : "Opted out"}
                  </Badge>
                </div>
                {row.topic.description ? (
                  <p className="break-words text-sm text-muted-foreground">
                    {row.topic.description}
                  </p>
                ) : null}
                <p className="break-all text-xs text-muted-foreground">
                  {row.topic.slug} · workspace default:{" "}
                  {row.topic.defaultOptIn ? "opted in" : "opted out"}
                </p>
              </div>
              <ConfirmDialog
                title={`${next ? "Opt in to" : "Opt out of"} “${row.topic.name}”?`}
                description={`This records an administrative topic ${next ? "opt-in" : "opt-out"} for ${email}. It does not change email consent, suppression, subscriber status, or send eligibility.`}
                confirmLabel={next ? "Record opt-in" : "Record opt-out"}
                confirmVariant={next ? "default" : "destructive"}
                onConfirm={() => update(row, next)}
                trigger={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    aria-describedby={
                      authority === null ? permissionReasonId : undefined
                    }
                    aria-label={`${next ? "Opt in to" : "Opt out of"} ${row.topic.name}`}
                  >
                    {busy ? "Saving…" : next ? "Opt in" : "Opt out"}
                  </Button>
                }
              />
            </li>
          );
        })}
      </ul>
      {authority === null ? (
        <p
          id={permissionReasonId}
          role="status"
          className="text-xs text-muted-foreground"
        >
          Viewer access can inspect topic choices but cannot change them.
        </p>
      ) : null}
    </section>
  );
}
