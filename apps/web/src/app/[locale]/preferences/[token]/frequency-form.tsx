// SPDX-License-Identifier: AGPL-3.0-only
//
// Smart-unsubscribe surface. Rendered on the preferences page when
// the operator links to /preferences/{token}?frequency=true (the
// "Manage frequency" link in the campaign unsubscribe footer).
//
// Backend: POST /api/public/preferences/{token}/frequency — writes
// to subscribers.frequency_preference + subscribers.paused_until.
// The sender path consults these before scheduling each send.
"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  type FrequencyChoice,
  type SmartUnsubscribeResponse,
  publicSmartUnsubscribe,
} from "@/lib/preferences-api";
import { expiredPreferenceRoute } from "@/lib/preference-form-errors";
import { preferredContrastingTextColor } from "@/lib/preference-branding-security";
import { asRoute } from "@/lib/typed-routes";

interface Props {
  token: string;
  email: string;
  initialChoice: FrequencyChoice;
  pausedUntil?: string;
  primaryColor?: string;
}

interface ChoiceOption {
  id: FrequencyChoice;
  titleKey: string;
  bodyKey: string;
}

// Single source of truth for the choice list. Translation keys
// reference the same `preferences.frequency.*` namespace so the
// page localises cleanly.
const CHOICES: ChoiceOption[] = [
  {
    id: "default",
    titleKey: "default_title",
    bodyKey: "default_body",
  },
  {
    id: "weekly",
    titleKey: "weekly_title",
    bodyKey: "weekly_body",
  },
  {
    id: "monthly",
    titleKey: "monthly_title",
    bodyKey: "monthly_body",
  },
  {
    id: "paused",
    titleKey: "paused_title",
    bodyKey: "paused_body",
  },
];

export function FrequencyForm({
  token,
  email,
  initialChoice,
  pausedUntil,
  primaryColor = "#5B6CFF",
}: Props) {
  const tr = useTranslations("preferences.frequency");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [choice, setChoice] = useState<FrequencyChoice>(initialChoice);
  const [pauseDays, setPauseDays] = useState<string>(() => {
    if (!pausedUntil) return "30";
    const timestamp = Date.parse(pausedUntil);
    if (!Number.isFinite(timestamp)) return "30";
    return String(
      Math.max(
        1,
        Math.min(365, Math.ceil((timestamp - Date.now()) / 86_400_000)),
      ),
    );
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SmartUnsubscribeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState(false);

  const handleSave = async () => {
    const parsedPauseDays = Number(pauseDays);
    if (
      choice === "paused" &&
      (!Number.isInteger(parsedPauseDays) ||
        parsedPauseDays < 1 ||
        parsedPauseDays > 365)
    ) {
      setPauseError(true);
      return;
    }
    const boundedPauseDays = Math.max(1, Math.min(365, parsedPauseDays));
    setPauseError(false);
    setSaving(true);
    setError(null);
    try {
      const res = await publicSmartUnsubscribe(token, {
        choice,
        pauseDays: choice === "paused" ? boundedPauseDays : undefined,
      });
      setSaved(res);
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
      aria-busy={saving}
      className="space-y-5"
    >
      <p className="break-words text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
        {tr("intro", { email })}
      </p>

      <fieldset className="space-y-3">
        <legend className="sr-only">{tr("choices_label")}</legend>
        {CHOICES.map((c) => (
          <label
            key={c.id}
            className={`flex min-h-16 cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ${
              choice === c.id
                ? "border-primary bg-primary/5"
                : "hover:bg-muted/50"
            }`}
            style={
              choice === c.id
                ? {
                    borderColor: primaryColor,
                    backgroundColor: `${primaryColor}0D`,
                  }
                : undefined
            }
          >
            <input
              type="radio"
              name="frequency"
              value={c.id}
              checked={choice === c.id}
              disabled={saving}
              onChange={() => {
                setChoice(c.id);
                setSaved(null);
                setError(null);
                setPauseError(false);
              }}
              className="mt-0.5 size-5 shrink-0 accent-primary"
              style={{ accentColor: primaryColor }}
            />
            <span className="flex-1">
              <span className="block break-words text-sm font-medium">
                {tr(c.titleKey)}
              </span>
              <span className="mt-1 block break-words text-xs leading-5 text-muted-foreground">
                {tr(c.bodyKey)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {choice === "paused" ? (
        <label className="flex min-h-11 flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-3 text-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
          <span>{tr("pause_for")}</span>
          <input
            type="number"
            min={1}
            max={365}
            step={1}
            required
            value={pauseDays}
            disabled={saving}
            aria-invalid={pauseError || undefined}
            aria-describedby={pauseError ? "pause-days-error" : undefined}
            onChange={(e) => {
              setPauseDays(e.target.value);
              setPauseError(false);
              setSaved(null);
              setError(null);
            }}
            onBlur={() => {
              if (pauseDays.trim() === "") return;
              const parsed = Number(pauseDays);
              if (!Number.isFinite(parsed)) {
                setPauseError(true);
                return;
              }
              setPauseDays(
                String(Math.max(1, Math.min(365, Math.trunc(parsed)))),
              );
            }}
            className="min-h-11 w-24 rounded-md border bg-background px-3 py-2 text-base tabular-nums focus-visible:outline-none sm:text-sm"
          />
          <span>{tr("days")}</span>
          {pauseError ? (
            <span
              id="pause-days-error"
              className="basis-full text-xs font-medium text-destructive"
            >
              {tr("pause_days_error")}
            </span>
          ) : null}
        </label>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          loading={saving}
          className="min-h-11"
          style={{
            backgroundColor: primaryColor,
            borderColor: primaryColor,
            color: preferredContrastingTextColor(primaryColor),
          }}
        >
          {tr("save")}
        </Button>
        {saved && !error ? (
          <span
            role="status"
            aria-live="polite"
            className="text-sm font-medium text-emerald-700"
          >
            {saved.choice === "paused" && saved.pausedUntil
              ? tr("saved_paused_until", {
                  date: formatPublicDate(saved.pausedUntil, locale),
                })
              : tr("saved_generic")}
          </span>
        ) : null}
        {error ? (
          <span role="alert" className="text-sm font-medium text-destructive">
            {error}
          </span>
        ) : null}
      </div>

      <p className="border-t pt-4 text-xs leading-5 text-muted-foreground">
        {tr("legal_note")}
      </p>
    </form>
  );
}

function formatPublicDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}
