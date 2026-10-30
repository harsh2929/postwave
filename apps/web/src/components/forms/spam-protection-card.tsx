// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Per-form spam protection (desktop components/forms/FormSpamSettings.tsx):
// honeypot toggle, captcha provider (reCAPTCHA v2 / hCaptcha / Turnstile) with
// its public site key, and a per-IP rate limit. Saves PATCH /api/v1/forms/{id}
// with the form's full settings map (the server replaces `settings`
// wholesale) and the If-Match token of the version on screen.
//
// ENFORCEMENT, stated in the UI rather than implied: the honeypot runs on
// every submission regardless of the toggle; reCAPTCHA is enforced when the
// deployment has a reCAPTCHA secret; hCaptcha / Turnstile tokens and the
// per-form rate limit are stored but not yet enforced at submit.
//
// No secret key is collected. Verification secrets stay deployment-level:
// anything written into `settings` is returned by GET /api/v1/forms/{id} to
// every reader of the form.

import { useId, useMemo, useState } from "react";
import { toast } from "sonner";

import { EditConflictReloadBanner } from "@/components/forms/edit-conflict-reload-banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import { whoamiFresh, type MeResponse } from "@/lib/auth-api";
import {
  RATE_LIMIT_MAX,
  isFormEditConflict,
  parseSpamSettings,
  sameSpamSettings,
  saveFormSpamSettings,
  validateSpamSettings,
  type CaptchaProvider,
  type SpamSettings,
} from "@/lib/forms-extras-api";
import {
  FORM_READ_ONLY_MESSAGE,
  assertFreshFormAuthority,
  canWriteForms,
} from "@/lib/forms-authority";
import type { Form } from "@/lib/forms-types";

export const STALE_DRAFT_MESSAGE =
  "This form was saved somewhere else while you were editing spam protection. Reload the latest version before saving, so you do not overwrite that change.";

const PROVIDER_KEY_LABEL: Record<Exclude<CaptchaProvider, "">, string> = {
  recaptcha: "reCAPTCHA site key",
  hcaptcha: "hCaptcha site key",
  turnstile: "Turnstile site key",
};

interface SpamProtectionCardProps {
  /** The SERVER copy of the form (not an editor draft with unsaved edits). */
  form: Form;
  identity: MeResponse | null | undefined;
  /** Receives the server echo after a save or a conflict reload. */
  onSaved?: (form: Form) => void;
  /** Why saving is withheld right now (e.g. other unsaved edits on the page). */
  blockedReason?: string | null;
  className?: string;
}

function newer(a: Form, b: Form | null): Form {
  if (!b || b.id !== a.id) return a;
  const at = Date.parse(a.updatedAt);
  const bt = Date.parse(b.updatedAt);
  return Number.isFinite(at) && Number.isFinite(bt) && bt >= at ? b : a;
}

export function SpamProtectionCard({
  form,
  identity,
  onSaved,
  blockedReason,
  className,
}: SpamProtectionCardProps) {
  const ids = useId();
  // The latest version this card has itself seen come back from the server,
  // so a parent that does not re-render with the echo cannot revert the UI.
  const [adopted, setAdopted] = useState<Form | null>(null);
  const current = newer(form, adopted);
  const server = useMemo(
    () => parseSpamSettings(current.settings),
    [current.settings],
  );
  const [draft, setDraft] = useState<SpamSettings | null>(null);
  const [draftBase, setDraftBase] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState("");

  const value = draft ?? server;
  const dirty = draft !== null && !sameSpamSettings(draft, server);
  const staleDraft =
    dirty && draftBase !== null && draftBase !== current.updatedAt;
  const problems = validateSpamSettings(value);

  const canWrite = canWriteForms(identity);
  const archived = current.status === "archived";
  const withheld = !canWrite
    ? FORM_READ_ONLY_MESSAGE
    : archived
      ? "Archived forms are read-only — duplicate the form to change its spam protection."
      : (blockedReason ?? null);
  const controlsDisabled = withheld !== null || saving;

  function set(patch: Partial<SpamSettings>) {
    if (controlsDisabled) return;
    if (draft === null) setDraftBase(current.updatedAt);
    setSavedNote("");
    setDraft({ ...value, ...patch });
  }

  function adopt(latest: Form) {
    setAdopted(latest);
    setDraft(null);
    setDraftBase(null);
    setConflict(false);
    setError(null);
    onSaved?.(latest);
  }

  async function save() {
    if (!dirty || problems || withheld || staleDraft) return;
    setSaving(true);
    setError(null);
    setSavedNote("");
    try {
      const fresh = await whoamiFresh();
      assertFreshFormAuthority(identity, fresh, "write");
      const updated = await saveFormSpamSettings(current, value);
      adopt(updated);
      setSavedNote("Spam protection saved.");
      toast.success("Spam protection saved.");
    } catch (err) {
      if (isFormEditConflict(err)) {
        setConflict(true);
      } else {
        setError(apiErrorMessage(err, "Could not save spam protection."));
      }
    } finally {
      setSaving(false);
    }
  }

  const withheldId = `${ids}-withheld`;
  const rateHelpId = `${ids}-rate-help`;
  const rateErrorId = `${ids}-rate-error`;
  const keyHelpId = `${ids}-key-help`;
  const keyErrorId = `${ids}-key-error`;

  return (
    <section
      className={className ?? "space-y-4"}
      aria-labelledby={`${ids}-title`}
    >
      <h3 id={`${ids}-title`} className="text-sm font-semibold">
        Spam protection
      </h3>
      <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          The honeypot runs on every submission.
        </span>{" "}
        reCAPTCHA is verified only when this deployment has a reCAPTCHA secret
        configured. hCaptcha and Turnstile tokens and the per-form rate limit
        are saved with the form but not yet enforced at submit — do not rely on
        them for bot protection yet.
      </p>

      {withheld ? (
        <p id={withheldId} role="note" className="text-xs text-muted-foreground">
          {withheld}
        </p>
      ) : null}

      {conflict || staleDraft ? (
        <EditConflictReloadBanner
          formId={current.id}
          hasUnsavedChanges={dirty}
          message={conflict ? undefined : STALE_DRAFT_MESSAGE}
          onReloaded={adopt}
        />
      ) : null}

      <div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={value.honeypotEnabled}
            disabled={controlsDisabled}
            aria-describedby={withheld ? withheldId : undefined}
            onChange={(e) => set({ honeypotEnabled: e.target.checked })}
          />
          <span>
            <span className="font-medium">Honeypot field</span>
            <span className="block text-xs text-muted-foreground">
              A hidden &ldquo;website&rdquo; input bots fill and people never
              see. Always active on the public form — the server drops honeypot
              hits even when this is off.
            </span>
          </span>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <Label htmlFor={`${ids}-provider`}>Captcha</Label>
          <Select
            id={`${ids}-provider`}
            value={value.captchaProvider}
            disabled={controlsDisabled}
            aria-describedby={withheld ? withheldId : undefined}
            onChange={(e) =>
              set({ captchaProvider: e.target.value as CaptchaProvider })
            }
          >
            <option value="">None</option>
            <option value="recaptcha">reCAPTCHA v2</option>
            <option value="hcaptcha">hCaptcha</option>
            <option value="turnstile">Cloudflare Turnstile</option>
          </Select>
        </div>

        {value.captchaProvider ? (
          <div className="min-w-0">
            <Label htmlFor={`${ids}-site-key`}>
              {PROVIDER_KEY_LABEL[value.captchaProvider]}
            </Label>
            <Input
              id={`${ids}-site-key`}
              className="font-mono text-xs"
              value={value.captchaSiteKey}
              placeholder={
                value.captchaProvider === "recaptcha"
                  ? "Blank = deployment default"
                  : "Public site key"
              }
              autoComplete="off"
              spellCheck={false}
              disabled={controlsDisabled}
              aria-invalid={problems?.siteKey ? true : undefined}
              aria-describedby={problems?.siteKey ? keyErrorId : keyHelpId}
              onChange={(e) => set({ captchaSiteKey: e.target.value })}
            />
            {problems?.siteKey ? (
              <p id={keyErrorId} className="mt-1 text-xs text-destructive">
                {problems.siteKey}
              </p>
            ) : (
              <p id={keyHelpId} className="mt-1 text-xs text-muted-foreground">
                {value.captchaProvider === "recaptcha"
                  ? "Public site key only — never the secret. It must pair with the deployment's reCAPTCHA secret to verify."
                  : "Stored for when this provider is verified at submit. Public site key only — never the secret."}
              </p>
            )}
          </div>
        ) : null}

        <div className="min-w-0">
          <Label htmlFor={`${ids}-rate`}>
            Rate limit (submissions / minute / IP)
          </Label>
          <Input
            id={`${ids}-rate`}
            type="number"
            inputMode="numeric"
            min={0}
            max={RATE_LIMIT_MAX}
            step={1}
            placeholder="Blank = off"
            value={value.rateLimitPerMin === "" ? "" : String(value.rateLimitPerMin)}
            disabled={controlsDisabled}
            aria-invalid={problems?.rateLimit ? true : undefined}
            aria-describedby={problems?.rateLimit ? rateErrorId : rateHelpId}
            onChange={(e) => {
              const raw = e.target.value.trim();
              set({ rateLimitPerMin: raw === "" ? "" : Number(raw) });
            }}
          />
          {problems?.rateLimit ? (
            <p id={rateErrorId} className="mt-1 text-xs text-destructive">
              {problems.rateLimit}
            </p>
          ) : (
            <p id={rateHelpId} className="mt-1 text-xs text-muted-foreground">
              Not enforced per form yet — the public endpoint applies only a
              global per-IP limit. Saved for when per-form limits ship.
            </p>
          )}
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void save()}
          disabled={
            controlsDisabled || !dirty || problems !== null || staleDraft || conflict
          }
          aria-describedby={withheld ? withheldId : undefined}
        >
          {saving ? "Saving…" : "Save spam protection"}
        </Button>
        <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {savedNote}
        </span>
      </div>
    </section>
  );
}
