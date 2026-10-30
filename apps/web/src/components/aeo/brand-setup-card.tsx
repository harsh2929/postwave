// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  putAeoSettings,
  type AEOEngineConfig,
  type AEOPromptPack,
  type AEOSettings,
} from "@/lib/aeo-api";
import { apiErrorMessage } from "@/lib/api";

import {
  CONFIGURABLE_ENGINES,
  ENGINE_LABEL,
  MAX_BRAND_TERMS,
  splitTerms,
} from "./aeo-format";

const PROMPT_PACKS: { key: AEOPromptPack; label: string }[] = [
  { key: "starter", label: "Starter pack" },
  { key: "custom", label: "Custom prompts only" },
  { key: "starter_plus_custom", label: "Starter + custom" },
];

export interface BrandSetupCardProps {
  settings: AEOSettings | null;
  canWrite: boolean;
  /** id of the element explaining why writes are unavailable. */
  gateDescribedBy: string;
  writeDeniedReason: string | null;
  onSaved: () => void;
}

/**
 * Brand setup — the AEO signal cannot compute without brand terms + domain.
 * Desktop edits enabled / domain / terms; the settings type also carries the
 * engine roster, probe interval, prompt pack and volatility window, so those
 * are editable here and sent in the same PUT (the server clamps out-of-range
 * numbers and defaults an empty engine list).
 */
export function BrandSetupCard({
  settings,
  canWrite,
  gateDescribedBy,
  writeDeniedReason,
  onSaved,
}: BrandSetupCardProps) {
  const uid = useId();
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [domain, setDomain] = useState(settings?.brand_domain ?? "");
  const [termsText, setTermsText] = useState(
    settings ? settings.brand_terms.join(", ") : "",
  );
  const [engines, setEngines] = useState<AEOEngineConfig[]>(
    settings ? settings.engines : [],
  );
  const [intervalHours, setIntervalHours] = useState(
    String(settings?.probe_interval_hours ?? 24),
  );
  const [promptPack, setPromptPack] = useState<AEOPromptPack>(
    settings?.probe_prompt_pack ?? "starter",
  );
  const [windowDays, setWindowDays] = useState(
    String(settings?.volatility_window_days ?? 14),
  );

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setDomain(settings.brand_domain);
    setTermsText(settings.brand_terms.join(", "));
    setEngines(settings.engines);
    setIntervalHours(String(settings.probe_interval_hours));
    setPromptPack(settings.probe_prompt_pack);
    setWindowDays(String(settings.volatility_window_days));
  }, [settings]);

  const save = useMutation({
    mutationFn: putAeoSettings,
    onSuccess: () => {
      toast.success("Brand setup saved");
      onSaved();
    },
    onError: (err: unknown) => {
      toast.error("Save failed", { description: apiErrorMessage(err) });
    },
  });

  const engineEnabled = (key: AEOEngineConfig["key"]): boolean =>
    engines.some((e) => e.key === key && e.enabled);

  const setEngine = (key: AEOEngineConfig["key"], next: boolean): void => {
    setEngines((current) => {
      const rest = current.filter((e) => e.key !== key);
      return [...rest, { key, enabled: next }];
    });
  };

  function onSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canWrite || save.isPending) return;
    const interval = Number(intervalHours);
    const window = Number(windowDays);
    save.mutate({
      enabled,
      brand_domain: domain.trim(),
      brand_terms: splitTerms(termsText, MAX_BRAND_TERMS),
      engines: CONFIGURABLE_ENGINES.map((key) => ({
        key,
        enabled: engineEnabled(key),
      })),
      probe_interval_hours: Number.isFinite(interval) ? interval : 24,
      probe_prompt_pack: promptPack,
      volatility_window_days: Number.isFinite(window) ? window : 14,
    });
  }

  const writeTitle = writeDeniedReason ?? undefined;
  const describedBy = canWrite ? undefined : gateDescribedBy;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Brand setup</CardTitle>
        <CardDescription>
          Brand terms and domain drive the mention and citation scores.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <fieldset disabled={!canWrite} className="space-y-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={enabled}
                onChange={(e) => setEnabled(e.currentTarget.checked)}
                aria-describedby={describedBy}
              />
              <span>Enable AEO Sensor probing</span>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-domain`}>
                  Brand domain (for citation rate)
                </Label>
                <Input
                  id={`${uid}-domain`}
                  value={domain}
                  placeholder="moosewave.com"
                  onChange={(e) => setDomain(e.currentTarget.value)}
                  aria-describedby={describedBy}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-terms`}>
                  Brand terms (comma-separated, max {MAX_BRAND_TERMS})
                </Label>
                <Input
                  id={`${uid}-terms`}
                  value={termsText}
                  placeholder="Moosewave, Moosewave Marketing, postwave"
                  onChange={(e) => setTermsText(e.currentTarget.value)}
                  aria-describedby={describedBy}
                />
              </div>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Engines to probe</legend>
              <div className="flex flex-wrap gap-4">
                {CONFIGURABLE_ENGINES.map((key) => (
                  <label
                    key={key}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={engineEnabled(key)}
                      onChange={(e) => setEngine(key, e.currentTarget.checked)}
                      aria-describedby={describedBy}
                    />
                    <span>{ENGINE_LABEL[key]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-interval`}>
                  Probe interval (hours, 6–168)
                </Label>
                <Input
                  id={`${uid}-interval`}
                  type="number"
                  min={6}
                  max={168}
                  value={intervalHours}
                  onChange={(e) => setIntervalHours(e.currentTarget.value)}
                  aria-describedby={describedBy}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-pack`}>Prompt pack</Label>
                <Select
                  id={`${uid}-pack`}
                  value={promptPack}
                  onChange={(e) =>
                    setPromptPack(e.currentTarget.value as AEOPromptPack)
                  }
                  aria-describedby={describedBy}
                >
                  {PROMPT_PACKS.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-window`}>
                  Volatility window (days, 3–60)
                </Label>
                <Input
                  id={`${uid}-window`}
                  type="number"
                  min={3}
                  max={60}
                  value={windowDays}
                  onChange={(e) => setWindowDays(e.currentTarget.value)}
                  aria-describedby={describedBy}
                />
              </div>
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              disabled={!canWrite || save.isPending}
              loading={save.isPending}
              title={writeTitle}
              aria-describedby={describedBy}
            >
              {save.isPending ? "Saving…" : "Save brand setup"}
            </Button>
            {settings ? (
              <span className="text-xs text-muted-foreground">
                Credentials: {settings.credentials_status}
              </span>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
