// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  publicUpdate,
  publicUnsubscribeAll,
  type PreferenceLookupResponse,
} from "@/lib/preferences-api";
import { expiredPreferenceRoute } from "@/lib/preference-form-errors";
import { preferredContrastingTextColor } from "@/lib/preference-branding-security";
import { asRoute } from "@/lib/typed-routes";

interface Props {
  token: string;
  initial: PreferenceLookupResponse;
  primaryColor?: string;
}

export function PreferencesForm({
  token,
  initial,
  primaryColor = "#5B6CFF",
}: Props) {
  const tr = useTranslations("preferences");
  const pathname = usePathname();
  const router = useRouter();
  const [topics, setTopics] = useState(initial.topics);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsubscribed, setUnsubscribed] = useState(false);
  const [confirmingUnsubscribe, setConfirmingUnsubscribe] = useState(false);
  const unsubscribeTriggerRef = useRef<HTMLButtonElement>(null);
  const unsubscribeConfirmRef = useRef<HTMLButtonElement>(null);

  const toggle = (id: string) => {
    setSavedAt(null);
    setError(null);
    setConfirmingUnsubscribe(false);
    setTopics((cur) =>
      cur.map((tp) =>
        tp.topic.id === id ? { ...tp, optedIn: !tp.optedIn } : tp,
      ),
    );
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await publicUpdate(
        token,
        topics.map((tp) => ({ topicId: tp.topic.id, optedIn: tp.optedIn })),
      );
      setSavedAt(Date.now());
    } catch (saveError) {
      const expiredRoute = expiredPreferenceRoute(saveError, pathname);
      if (expiredRoute) {
        router.replace(asRoute(expiredRoute));
        return;
      }
      setError(tr("save_error"));
    } finally {
      setSaving(false);
    }
  };

  const handleUnsubscribeAll = async () => {
    setSaving(true);
    setError(null);
    try {
      await publicUnsubscribeAll(token);
      setTopics((current) =>
        current.map((topic) => ({ ...topic, optedIn: false })),
      );
      setUnsubscribed(true);
      setConfirmingUnsubscribe(false);
      setSavedAt(Date.now());
    } catch (saveError) {
      const expiredRoute = expiredPreferenceRoute(saveError, pathname);
      if (expiredRoute) {
        router.replace(asRoute(expiredRoute));
        return;
      }
      setError(tr("save_error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void handleSave();
      }}
      className="space-y-5"
    >
      {initial.gpc ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mt-0.5 h-4 w-4 shrink-0"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <span>{tr("gpc_notice")}</span>
        </div>
      ) : null}

      {topics.length > 0 ? (
        <ul className="space-y-3">
          {topics.map((tp) => (
            <li
              key={tp.topic.id}
              className="rounded-lg border transition-colors hover:bg-muted/40 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
            >
              <label
                htmlFor={`tp-${tp.topic.id}`}
                className="flex min-h-14 cursor-pointer items-start gap-3 p-4"
              >
                <input
                  id={`tp-${tp.topic.id}`}
                  type="checkbox"
                  checked={tp.optedIn}
                  disabled={unsubscribed || saving}
                  onChange={() => toggle(tp.topic.id)}
                  className="mt-0.5 size-5 shrink-0 accent-primary"
                  style={{ accentColor: primaryColor }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-medium">
                    {tp.topic.name}
                  </span>
                  {tp.topic.description ? (
                    <span className="mt-1 block break-words text-xs leading-5 text-muted-foreground">
                      {tp.topic.description}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
          {tr("no_topics")}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          loading={saving && !confirmingUnsubscribe}
          disabled={saving || unsubscribed || topics.length === 0}
          className="min-h-11"
          style={{
            backgroundColor: primaryColor,
            borderColor: primaryColor,
            color: preferredContrastingTextColor(primaryColor),
          }}
        >
          {tr("save")}
        </Button>
        {savedAt && !error ? (
          <span
            role="status"
            aria-live="polite"
            className="text-sm font-medium text-emerald-700"
          >
            {tr("saved")}
          </span>
        ) : null}
        {error ? (
          <span role="alert" className="text-sm font-medium text-destructive">
            {error}
          </span>
        ) : null}
      </div>
      <div className="space-y-3 border-t pt-5">
        {!confirmingUnsubscribe ? (
          <Button
            ref={unsubscribeTriggerRef}
            type="button"
            variant="destructive"
            disabled={saving || unsubscribed}
            className="min-h-11"
            onClick={() => {
              setConfirmingUnsubscribe(true);
              requestAnimationFrame(() =>
                unsubscribeConfirmRef.current?.focus(),
              );
            }}
          >
            {tr("unsubscribe_all")}
          </Button>
        ) : (
          <div
            role="alertdialog"
            aria-labelledby="unsubscribe-confirm-title"
            aria-describedby="unsubscribe-confirm-body"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-4"
          >
            <p id="unsubscribe-confirm-title" className="font-medium">
              {tr("unsubscribe_confirm_title")}
            </p>
            <p
              id="unsubscribe-confirm-body"
              className="mt-1 text-sm leading-6 text-muted-foreground"
            >
              {tr("unsubscribe_confirm_body")}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={saving}
                onClick={() => {
                  setConfirmingUnsubscribe(false);
                  requestAnimationFrame(() =>
                    unsubscribeTriggerRef.current?.focus(),
                  );
                }}
              >
                {tr("unsubscribe_keep")}
              </Button>
              <Button
                ref={unsubscribeConfirmRef}
                type="button"
                variant="destructive"
                loading={saving}
                className="min-h-11"
                onClick={() => void handleUnsubscribeAll()}
              >
                {tr("unsubscribe_confirm")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </form>
  );
}
