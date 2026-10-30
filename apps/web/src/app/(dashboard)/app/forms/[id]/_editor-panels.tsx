// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// The Design and Settings tabs of the form editor. Neither is shown on first
// paint (the Builder tab is the default), so the page loads this module with
// next/dynamic and keeps the tab bodies — and the HTML compiler the Design tab
// needs — out of the eager route graph (bundle budget).

import dynamic from "next/dynamic";
import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { compileFormHtml, safeFormSuccessRedirectUrl } from "@/lib/forms-types";
import type { Form, FormSettings, OptInMode } from "@/lib/forms-types";

import { DeferredFormPanel } from "./_deferred-form-panel";

const FormPreview = dynamic(
  () =>
    import("@/components/forms/form-preview").then((mod) => mod.FormPreview),
  {
    ssr: false,
    loading: () => <DeferredFormPanel label="form preview" />,
  },
);

const TargetListPicker = dynamic(
  () => import("./_list-picker").then((mod) => mod.TargetListPicker),
  {
    ssr: false,
    loading: () => <DeferredFormPanel label="target list picker" />,
  },
);

// --- Design tab (FORM-011): expose the styleClass CSS hook -----------------

export function DesignPanel({
  form,
  onPatchSettings,
}: {
  form: Form;
  onPatchSettings: (p: Partial<FormSettings>) => void;
}) {
  const styleClass = form.settings.styleClass ?? "";
  const compiledTag = compileFormHtml(form).split("\n")[0];
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-5xl">
      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Styling</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Public forms render with the <code>.postwave-form</code> class. Add
            your own CSS class hooks here to style the form from your
            site&apos;s stylesheet (or the inline embed&apos;s CSS).
          </p>
        </div>
        <div>
          <Label htmlFor="style-class">CSS class hooks</Label>
          <Input
            id="style-class"
            value={styleClass}
            placeholder="brand-form rounded-xl dark"
            onChange={(e) => onPatchSettings({ styleClass: e.target.value })}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Space-separated. Only letters, numbers, <code>-</code>,{" "}
            <code>_</code>, and <code>:</code> are kept in the compiled output
            (up to 12 classes).
          </p>
        </div>
        <div>
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Compiled form tag
          </span>
          <pre
            tabIndex={0}
            role="group"
            aria-label="Compiled style classes"
            className="mt-1 overflow-x-auto rounded-md bg-muted p-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {compiledTag}
          </pre>
        </div>
        <div className="flex flex-wrap gap-2">
          {["rounded-xl", "compact", "brand", "dark"].map((preset) => {
            const tokens = styleClass.split(/\s+/).filter(Boolean);
            const active = tokens.includes(preset);
            return (
              <Button
                key={preset}
                type="button"
                size="sm"
                variant={active ? "secondary" : "outline"}
                onClick={() => {
                  const nextTokens = active
                    ? tokens.filter((t) => t !== preset)
                    : [...tokens, preset];
                  onPatchSettings({ styleClass: nextTokens.join(" ") });
                }}
              >
                {preset}
              </Button>
            );
          })}
        </div>
      </section>
      <section>
        <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-2">
          Live preview
        </h3>
        <FormPreview form={form} height={520} />
      </section>
    </div>
  );
}

interface SettingsPanelProps {
  form: Form;
  origin: string;
  onPatchTop: <K extends keyof Form>(k: K, v: Form[K]) => void;
  onPatchSettings: (p: Partial<FormSettings>) => void;
  /** Spam protection saves on its own (SpamProtectionCard). */
  spamProtection: ReactNode;
}

export function SettingsPanel({
  form,
  origin,
  onPatchTop,
  onPatchSettings,
  spamProtection,
}: SettingsPanelProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl">
      <section className="space-y-4">
        <h3 className="text-sm font-semibold">Opt-in</h3>
        <fieldset>
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="optInMode"
                checked={form.optInMode === "double"}
                onChange={() => onPatchTop("optInMode", "double" as OptInMode)}
              />
              <span>
                <span className="font-medium">Double opt-in</span>
                <span className="block text-xs text-muted-foreground">
                  Confirm-by-email before subscribing.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="optInMode"
                checked={form.optInMode === "single"}
                onChange={() => onPatchTop("optInMode", "single" as OptInMode)}
              />
              <span>
                <span className="font-medium">Single opt-in</span>
                <span className="block text-xs text-muted-foreground">
                  Subscribe immediately on submit.
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <h3 className="text-sm font-semibold pt-4">Slug</h3>
        <Input
          value={form.slug}
          aria-label="Form slug"
          onChange={(e) => onPatchTop("slug", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {origin}/forms/
          <span className="text-foreground">{form.slug}</span>
        </p>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold">Success</h3>
        <div>
          <Label htmlFor="success-message">Success message</Label>
          <Textarea
            id="success-message"
            value={form.settings.successMessage}
            onChange={(e) =>
              onPatchSettings({ successMessage: e.target.value })
            }
            rows={3}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Tiptap-style rich text comes in V1.1; for now plain text + simple
            links.
          </p>
        </div>
        <div>
          <Label htmlFor="success-redirect">Redirect URL (optional)</Label>
          <Input
            id="success-redirect"
            type="url"
            value={form.settings.successRedirectUrl ?? ""}
            onChange={(e) => {
              const value = e.target.value;
              const safe = safeFormSuccessRedirectUrl(value);
              onPatchSettings({
                successRedirectUrl: safe === null ? value : safe || undefined,
              });
            }}
          />
          {form.settings.successRedirectUrl &&
          safeFormSuccessRedirectUrl(form.settings.successRedirectUrl) ===
            null ? (
            <p className="mt-1 text-xs text-destructive">
              Use HTTPS, localhost HTTP, or a root-relative path.
            </p>
          ) : null}
        </div>
      </section>

      {form.optInMode === "double" && (
        <section className="space-y-4 md:col-span-2 border-t pt-6">
          <h3 className="text-sm font-semibold">Confirmation email</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="conf-from-email">Sender address</Label>
              <Input
                id="conf-from-email"
                type="email"
                autoComplete="off"
                placeholder="news@yourdomain.com"
                value={form.settings.confirmationFromEmail ?? ""}
                onChange={(e) =>
                  onPatchSettings({
                    confirmationFromEmail: e.target.value.trim() || undefined,
                  })
                }
                aria-describedby="conf-from-help"
              />
            </div>
            <div>
              <Label htmlFor="conf-from-name">Sender name</Label>
              <Input
                id="conf-from-name"
                autoComplete="off"
                placeholder="Your workspace name"
                value={form.settings.confirmationFromName ?? ""}
                onChange={(e) =>
                  onPatchSettings({
                    confirmationFromName: e.target.value || undefined,
                  })
                }
                aria-describedby="conf-from-help"
              />
            </div>
            <p id="conf-from-help" className="text-xs text-muted-foreground sm:col-span-2">
              Use an address on one of your{" "}
              <Link
                href="/app/settings/domain"
                className="underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
              >
                verified domains
              </Link>
              . The subject and body below are sent only from such an address;
              otherwise visitors get a standard confirmation email that names
              your workspace and this form.
            </p>
          </div>
          <div>
            <Label htmlFor="conf-subject">Subject</Label>
            <Input
              id="conf-subject"
              value={form.settings.confirmationSubject ?? ""}
              onChange={(e) =>
                onPatchSettings({ confirmationSubject: e.target.value })
              }
            />
          </div>
          <div>
            <Label htmlFor="conf-body">Body</Label>
            <Textarea
              id="conf-body"
              value={form.settings.confirmationBody ?? ""}
              onChange={(e) =>
                onPatchSettings({ confirmationBody: e.target.value })
              }
              rows={6}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Use <code>{"{{confirm_url}}"}</code> for the confirmation link.
            </p>
          </div>
        </section>
      )}

      {spamProtection}

      <section className="space-y-4 md:col-span-2 border-t pt-6">
        <h3 className="text-sm font-semibold">Subscriber wiring</h3>
        <TargetListPicker
          value={form.settings.targetListId ?? ""}
          onChange={(next) => onPatchSettings({ targetListId: next })}
        />
        <div>
          <Label htmlFor="tags">Tags on submit (comma-separated)</Label>
          <Input
            id="tags"
            value={(form.settings.tagsOnSubmit ?? []).join(", ")}
            onChange={(e) =>
              onPatchSettings({
                tagsOnSubmit: e.target.value
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              })
            }
            placeholder="newsletter, v2-signup"
          />
        </div>
      </section>
    </div>
  );
}
