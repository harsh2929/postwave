// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { createForm, listForms, updateForm } from "@/lib/forms-api";
import { useFormsOrigin } from "@/lib/use-forms-origin";
import { FORM_TEMPLATES } from "@/lib/form-templates";
import { effectiveAuthRole, whoami, whoamiFresh } from "@/lib/auth-api";
import {
  assertFreshFormAuthority,
  canWriteForms,
  FORM_READ_ONLY_MESSAGE,
} from "@/lib/forms-authority";
import { base, qk, STALE } from "@/lib/query-keys";
import {
  canNavigateWithUnsavedChanges,
  useUnsavedChangesGuard,
} from "@/lib/use-unsaved-changes-guard";
import {
  safeFormSuccessRedirectUrl,
  slugify,
  validateFormSlug,
  type Form,
  type OptInMode,
} from "@/lib/forms-types";

const MAX_FORM_NAME_LENGTH = 200;

/**
 * What a new form says after a submission, before anybody writes their own.
 *
 * It has to follow the opt-in mode: a single opt-in subscribes the visitor
 * there and then, so telling them to check their inbox for a confirmation that
 * is never sent leaves them waiting for an email that will not arrive. Every
 * new form used to promise exactly that.
 */
const DEFAULT_SUCCESS_MESSAGES: Record<OptInMode, string> = {
  double: "Thanks! Check your inbox to confirm your subscription.",
  single: "Thanks for subscribing. You're on the list.",
};

export default function NewFormPage() {
  const router = useRouter();
  const origin = useFormsOrigin();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data;
  const canWrite = canWriteForms(identity);
  const queryClient = useQueryClient();
  // The prefix every forms read keys under (the list page, the editor).
  const formsScopeKey = base(
    "forms",
    identity?.tenant_id ?? "anon",
    identity ? effectiveAuthRole(identity) : null,
  );

  const [templateId, setTemplateId] = useState("newsletter");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [optInMode, setOptInMode] = useState<OptInMode>("double");
  const [successMessage, setSuccessMessage] = useState(
    DEFAULT_SUCCESS_MESSAGES.double,
  );
  // Once the operator has written their own message, changing the opt-in mode
  // must not overwrite it.
  const [successMessageAuthored, setSuccessMessageAuthored] = useState(false);
  const [redirectUrl, setRedirectUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createdForm, setCreatedForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitLockRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const redirectRef = useRef<HTMLInputElement>(null);
  const validationFocusFrameRef = useRef<number | null>(null);

  // Per-field inline validation (FORM-023).
  const [nameError, setNameError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [redirectError, setRedirectError] = useState<string | null>(null);
  const [existingSlugs, setExistingSlugs] = useState<Set<string> | null>(null);

  // Guard against losing a partially-filled form (FORM-043).
  const dirty =
    templateId !== "newsletter" ||
    name.trim().length > 0 ||
    slug.trim().length > 0 ||
    optInMode !== "double" ||
    successMessageAuthored ||
    redirectUrl.trim().length > 0;
  useUnsavedChangesGuard(dirty);
  const draftLocked = submitting || createdForm !== null || !canWrite;

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(
    () => () => {
      if (validationFocusFrameRef.current !== null) {
        cancelAnimationFrame(validationFocusFrameRef.current);
      }
    },
    [],
  );

  // Best-effort slug-uniqueness source: the list already returns every form.
  useEffect(() => {
    let active = true;
    if (!canWrite) {
      setExistingSlugs(null);
      return;
    }
    listForms()
      .then((forms) => {
        if (active)
          setExistingSlugs(new Set(forms.map((f) => f.slug.toLowerCase())));
      })
      .catch(() => {
        /* uniqueness check is best-effort; server still enforces it */
      });
    return () => {
      active = false;
    };
  }, [canWrite]);

  async function verifyWriteAuthority() {
    if (!identity) throw new Error("Workspace identity is unavailable.");
    const fresh = await whoamiFresh();
    assertFreshFormAuthority(identity, fresh, "write");
  }

  // `onNameChange` owns the one intentional auto-fill. Once the user edits
  // (including clears) the slug, both the preview and submitted value must
  // reflect that explicit choice instead of quietly deriving another value.
  const effectiveSlug = slug.trim();

  function onNameChange(v: string) {
    setName(v);
    if (nameError) setNameError(checkName(v));
    if (!slugTouched) setSlug(slugify(v));
  }

  function checkName(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return "Name is required.";
    if (trimmed.length > MAX_FORM_NAME_LENGTH) {
      return `Name must be ${MAX_FORM_NAME_LENGTH} characters or fewer.`;
    }
    return null;
  }

  function checkSlug(value: string): string | null {
    const formatError = validateFormSlug(value);
    if (formatError) return formatError;
    const normalized = value.toLowerCase();
    if (existingSlugs?.has(normalized)) {
      return "That slug is already taken. Choose a different one.";
    }
    return null;
  }

  function validateRedirect(value: string): string | null {
    return safeFormSuccessRedirectUrl(value) === null
      ? "Redirect URL must be HTTPS, localhost HTTP, or root-relative."
      : null;
  }

  function applyTemplate(id: string) {
    setTemplateId(id);
    const t = FORM_TEMPLATES.find((tpl) => tpl.id === id);
    if (t) chooseOptInMode(t.optInMode);
  }

  // The mode's default message travels with the mode until the operator has
  // written one of their own.
  function chooseOptInMode(mode: OptInMode) {
    setOptInMode(mode);
    if (!successMessageAuthored)
      setSuccessMessage(DEFAULT_SUCCESS_MESSAGES[mode]);
  }

  function focusInvalidField(ref: React.RefObject<HTMLInputElement | null>) {
    const target = ref.current;
    if (!target) return;

    // Focus immediately for assistive technology, then once more after React
    // commits the inline-error state. When multiple fields already failed on
    // blur, the submit button's native activation/focus bookkeeping can run
    // after the synchronous handler and otherwise reclaim focus.
    target.focus();
    if (validationFocusFrameRef.current !== null) {
      cancelAnimationFrame(validationFocusFrameRef.current);
    }
    validationFocusFrameRef.current = requestAnimationFrame(() => {
      validationFocusFrameRef.current = null;
      if (target.isConnected && !target.disabled) target.focus();
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitLockRef.current) return;
    setError(null);
    if (!canWrite) {
      setError(FORM_READ_ONLY_MESSAGE);
      return;
    }
    if (!createdForm) {
      const nameMsg = checkName(name);
      const slugMsg = checkSlug(slug.trim());
      const redirectMsg = validateRedirect(redirectUrl);
      setNameError(nameMsg);
      setSlugError(slugMsg);
      setRedirectError(redirectMsg);
      if (nameMsg || slugMsg || redirectMsg) {
        focusInvalidField(nameMsg ? nameRef : slugMsg ? slugRef : redirectRef);
        return;
      }
    }

    submitLockRef.current = true;
    setSubmitting(true);
    const safeRedirectUrl = safeFormSuccessRedirectUrl(redirectUrl);
    try {
      await verifyWriteAuthority();
      const form =
        createdForm ??
        (await createForm(
          {
            name: name.trim(),
            slug: slug.trim(),
            optInMode,
            successMessage,
            successRedirectUrl: safeRedirectUrl || undefined,
          },
          { requireOnline: true },
        ));
      // The form exists from here on, whether or not the starter applies:
      // /app/forms must list it the next time it is shown, not keep serving
      // the list it cached before this form was created.
      void queryClient.invalidateQueries({ queryKey: formsScopeKey });
      // Seed the chosen starter structure (FORM-028). "blank" keeps the
      // server default. The full field list is sent (PATCH = full replace).
      const template = FORM_TEMPLATES.find((t) => t.id === templateId);
      if (template && template.id !== "blank") {
        try {
          await verifyWriteAuthority();
          await updateForm(
            form.id,
            { structure: template.structure },
            { requireOnline: true },
          );
        } catch (err) {
          setCreatedForm(form);
          setError(
            `Form “${form.name}” was created, but the ${template.name} starter could not be applied. ${
              err instanceof Error ? err.message : "Try again when connected."
            } Retry the starter, or open the saved form without it.`,
          );
          setSubmitting(false);
          submitLockRef.current = false;
          return;
        }
      }
      router.push(`/app/forms/${form.id}`);
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message} Nothing was queued; reconnect and retry with the same draft.`
          : "Failed to create form. Nothing was queued; retry with the same draft.",
      );
      setSubmitting(false);
      submitLockRef.current = false;
    }
  }

  function cancelCreation() {
    if (submitLockRef.current) return;
    if (dirty && !canNavigateWithUnsavedChanges()) return;
    router.push("/app/forms");
  }

  function openCreatedForm() {
    if (!createdForm || submitLockRef.current) return;
    router.push(`/app/forms/${createdForm.id}`);
  }

  return (
    <div className="p-8 max-w-xl mx-auto">
      <h1 className="font-display text-2xl font-semibold tracking-tight mb-1">
        New form
      </h1>
      <p className="text-sm text-muted-foreground mb-6">
        Pick a starting point, set the basics — you can edit fields, settings,
        and styling on the next step.
      </p>

      {!meQuery.isPending && !canWrite ? (
        <p
          role="note"
          className="mb-5 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground"
        >
          {FORM_READ_ONLY_MESSAGE}
        </p>
      ) : null}

      <form onSubmit={onSubmit} className="space-y-5" aria-busy={submitting}>
        <fieldset>
          <legend className="text-sm font-medium mb-2">
            Start from a template
          </legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {FORM_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => applyTemplate(t.id)}
                aria-pressed={templateId === t.id}
                disabled={draftLocked}
                className={cn(
                  "relative rounded-md border bg-card px-3 py-2.5 text-left text-sm transition-colors hover:border-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
                  templateId === t.id && "border-primary ring-1 ring-primary",
                )}
              >
                {templateId === t.id ? (
                  <Check className="absolute right-2 top-2 h-4 w-4 text-primary" />
                ) : null}
                <div className="font-medium">{t.name}</div>
                <div className="text-xs text-muted-foreground">
                  {t.description}
                </div>
              </button>
            ))}
          </div>
        </fieldset>

        <div>
          <Label htmlFor="form-name">Name</Label>
          <Input
            id="form-name"
            ref={nameRef}
            placeholder="Newsletter signup"
            value={name}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "form-name-error" : "form-name-hint"}
            onChange={(e) => onNameChange(e.target.value)}
            onBlur={(e) => setNameError(checkName(e.target.value))}
            disabled={draftLocked}
            maxLength={MAX_FORM_NAME_LENGTH}
            required
          />
          {nameError ? (
            <p id="form-name-error" className="mt-1 text-xs text-destructive">
              {nameError}
            </p>
          ) : (
            <p
              id="form-name-hint"
              className="mt-1 text-xs text-muted-foreground"
            >
              {MAX_FORM_NAME_LENGTH} characters maximum.
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="form-slug">Slug</Label>
          <Input
            id="form-slug"
            ref={slugRef}
            placeholder="newsletter"
            value={slug}
            aria-invalid={slugError ? true : undefined}
            aria-describedby={slugError ? "form-slug-error" : "form-slug-hint"}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
              if (slugError) setSlugError(checkSlug(e.target.value.trim()));
            }}
            onBlur={(e) => setSlugError(checkSlug(e.target.value.trim()))}
            disabled={draftLocked}
            required
          />
          {slugError ? (
            <p id="form-slug-error" className="text-xs text-destructive mt-1">
              {slugError}
            </p>
          ) : (
            <p
              id="form-slug-hint"
              className="text-xs text-muted-foreground mt-1"
            >
              Hosted at{" "}
              <code className="text-foreground">
                {origin}/forms/{effectiveSlug || "your-slug"}
              </code>
              .
            </p>
          )}
        </div>

        <fieldset>
          <legend className="text-sm font-medium mb-2">Opt-in mode</legend>
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="optin"
                checked={optInMode === "double"}
                onChange={() => chooseOptInMode("double")}
                disabled={draftLocked}
                className="mt-0.5"
              />
              <div>
                <div className="font-medium">Double opt-in (recommended)</div>
                <div className="text-xs text-muted-foreground">
                  Subscribers confirm their address via email before joining.
                  Best for deliverability and GDPR.
                </div>
              </div>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="optin"
                checked={optInMode === "single"}
                onChange={() => chooseOptInMode("single")}
                disabled={draftLocked}
                className="mt-0.5"
              />
              <div>
                <div className="font-medium">Single opt-in</div>
                <div className="text-xs text-muted-foreground">
                  Subscribers join immediately on submit. Use only when you
                  trust the source.
                </div>
              </div>
            </label>
          </div>
        </fieldset>

        <div>
          <Label htmlFor="form-success">Success message</Label>
          <Textarea
            id="form-success"
            value={successMessage}
            onChange={(e) => {
              setSuccessMessageAuthored(true);
              setSuccessMessage(e.target.value);
            }}
            disabled={draftLocked}
            rows={3}
          />
        </div>

        <div>
          <Label htmlFor="form-redirect">Success redirect URL (optional)</Label>
          <Input
            id="form-redirect"
            ref={redirectRef}
            placeholder="https://example.com/thanks"
            value={redirectUrl}
            aria-invalid={redirectError ? true : undefined}
            aria-describedby={
              redirectError ? "form-redirect-error" : "form-redirect-hint"
            }
            onChange={(e) => {
              setRedirectUrl(e.target.value);
              if (redirectError)
                setRedirectError(validateRedirect(e.target.value));
            }}
            onBlur={(e) => setRedirectError(validateRedirect(e.target.value))}
            disabled={draftLocked}
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
          />
          <p
            id={redirectError ? "form-redirect-error" : "form-redirect-hint"}
            aria-live="polite"
            aria-atomic="true"
            className={cn(
              "mt-1 min-h-8 text-xs sm:min-h-4",
              redirectError ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {redirectError ??
              "Use HTTPS, localhost HTTP, or a root-relative path."}
          </p>
        </div>

        {error && (
          <div
            ref={errorRef}
            role="alert"
            tabIndex={-1}
            className="text-sm text-destructive-emphasis bg-destructive/10 px-3 py-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {error}
          </div>
        )}

        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={!canWrite || submitting || (!createdForm && !name.trim())}
            className="h-11 sm:h-9"
          >
            {submitting
              ? createdForm
                ? "Applying…"
                : "Creating…"
              : createdForm
                ? "Retry starter"
                : "Create"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={createdForm ? openCreatedForm : cancelCreation}
            disabled={submitting}
            className="h-11 sm:h-9"
          >
            {createdForm ? "Open saved form" : "Cancel"}
          </Button>
        </div>
      </form>
    </div>
  );
}
