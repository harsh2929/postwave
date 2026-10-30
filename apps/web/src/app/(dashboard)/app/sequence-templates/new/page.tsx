// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createTemplate, getTemplate } from "@/lib/voice-api";
import { asRoute } from "@/lib/typed-routes";
import type {
  SequenceTemplate,
  TemplateEmailSpec,
  TemplateVariable,
} from "@/lib/voice-types";

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function blankVariable(): TemplateVariable {
  return {
    key: "",
    label: "",
    description: "",
    type: "text",
    example: "",
    required: true,
  };
}

function blankEmail(position: number): TemplateEmailSpec {
  return { position, subjectHint: "", bodyHint: "", delayHours: 0 };
}

export default function NewSequenceTemplatePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromId = searchParams.get("from");

  const [name, setName] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [slug, setSlug] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [variables, setVariables] = useState<TemplateVariable[]>([]);
  const [emails, setEmails] = useState<TemplateEmailSpec[]>([blankEmail(1)]);
  const [saving, setSaving] = useState(false);
  const [copyState, setCopyState] = useState<"ready" | "loading" | "error">(
    fromId ? "loading" : "ready",
  );
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copyAttempt, setCopyAttempt] = useState(0);

  // A changed source must never leave the previous template's fields visible
  // while the replacement is loading. The form stays disabled until the new
  // source is either loaded or explicitly abandoned via “Start blank”.
  useEffect(() => {
    setName("");
    setSlugTouched(false);
    setSlug("");
    setCategory("");
    setDescription("");
    setVariables([]);
    setEmails([blankEmail(1)]);
    setCopyError(null);
    setCopyState(fromId ? "loading" : "ready");
  }, [fromId]);

  // Duplicate: pre-fill from an existing template (SEQ-050).
  useEffect(() => {
    if (!fromId) return;
    // Without this, switching ?from= mid-flight let the superseded template's
    // fields win and pre-fill the form from the wrong source template.
    let active = true;
    setCopyState("loading");
    setCopyError(null);
    void getTemplate(fromId)
      .then((t) => {
        if (!active) return;
        setName(`${t.name} (copy)`);
        setSlugTouched(true);
        setSlug(`${t.slug}-copy`);
        setCategory(t.category);
        setDescription(t.description);
        setVariables(t.variables.length ? t.variables : []);
        setEmails(t.emails.length ? t.emails : [blankEmail(1)]);
        setCopyState("ready");
      })
      .catch((err: unknown) => {
        if (!active) return;
        setCopyError(
          err instanceof Error
            ? err.message
            : "Could not load template to copy",
        );
        setCopyState("error");
      });
    return () => {
      active = false;
    };
  }, [copyAttempt, fromId]);

  const effectiveSlug = slugTouched ? slug : slugify(name);

  const updateVariable = (index: number, patch: Partial<TemplateVariable>) =>
    setVariables((prev) =>
      prev.map((v, i) => (i === index ? { ...v, ...patch } : v)),
    );
  const updateEmail = (index: number, patch: Partial<TemplateEmailSpec>) =>
    setEmails((prev) =>
      prev.map((e, i) => (i === index ? { ...e, ...patch } : e)),
    );

  const normalizedVariableKeys = variables
    .map((variable) => variable.key.trim())
    .filter(Boolean);
  const saveRequirements = [
    name.trim() === "" ? "a template name" : null,
    effectiveSlug === "" ? "a slug" : null,
    category.trim() === "" ? "a category" : null,
    emails.length === 0 || emails.some((email) => !email.subjectHint.trim())
      ? "a subject hint for every email"
      : null,
    variables.some((variable) => !variable.key.trim() || !variable.label.trim())
      ? "a key and label for every variable"
      : null,
    new Set(normalizedVariableKeys).size !== normalizedVariableKeys.length
      ? "unique variable keys"
      : null,
    emails.some(
      (email) => !Number.isFinite(email.delayHours) || email.delayHours < 0,
    )
      ? "a non-negative delay for every email"
      : null,
  ].filter((requirement): requirement is string => requirement !== null);
  const canSave = saveRequirements.length === 0;
  const copyBlocked = Boolean(fromId) && copyState !== "ready";

  const save = async () => {
    if (!canSave || copyBlocked || saving) return;
    setSaving(true);
    try {
      const payload: Omit<SequenceTemplate, "id" | "slug"> & { slug: string } =
        {
          slug: effectiveSlug,
          name: name.trim(),
          description: description.trim(),
          category: category.trim(),
          length: emails.length,
          variables: variables.map((v) => ({
            ...v,
            key: v.key.trim(),
            label: v.label.trim(),
          })),
          emails: emails.map((e, i) => ({ ...e, position: i + 1 })),
        };
      const created = await createTemplate(payload);
      toast.success("Template created.");
      router.push(asRoute(`/app/sequence-templates/${created.id}`));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not create template.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="mx-auto w-full min-w-0 max-w-3xl space-y-6 p-4 sm:p-6 lg:p-8"
      aria-busy={copyState === "loading" || saving}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Button asChild variant="ghost" className="-ml-3">
        <Link href={asRoute("/app/sequence-templates")}>
          <ArrowLeft className="h-4 w-4" />
          Sequence templates
        </Link>
      </Button>

      <header className="space-y-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{fromId ? "Duplicate" : "New"}</Badge>
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {fromId ? "Duplicate sequence template" : "New sequence template"}
        </h1>
        <p className="text-sm text-muted-foreground">
          Define the reusable structure. Everyone in your workspace can then
          generate sequences from it.
        </p>
      </header>

      {copyBlocked ? (
        <div
          id="sequence-template-copy-state"
          role={copyState === "error" ? "alert" : "status"}
          className={
            copyState === "error"
              ? "space-y-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-foreground"
              : "rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground"
          }
        >
          {copyState === "loading" ? (
            "Loading the source template before enabling this form…"
          ) : (
            <>
              <p>
                Could not load the template to duplicate
                {copyError ? `: ${copyError}` : ""}.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCopyAttempt((attempt) => attempt + 1)}
                >
                  Retry
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <Link href={asRoute("/app/sequence-templates/new")}>
                    Start blank
                  </Link>
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      <fieldset
        disabled={copyBlocked}
        aria-describedby={
          copyBlocked ? "sequence-template-copy-state" : undefined
        }
        className="contents"
      >
        <Card>
          <CardContent className="space-y-4 p-4 sm:p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-name">Name</Label>
                <Input
                  id="tpl-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Welcome series"
                  maxLength={200}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-slug">Slug</Label>
                <Input
                  id="tpl-slug"
                  value={effectiveSlug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(slugify(e.target.value));
                  }}
                  placeholder="welcome-series"
                  required
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-category">Category</Label>
              <Input
                id="tpl-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Onboarding"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-desc">Description</Label>
              <Textarea
                id="tpl-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="A three-email welcome for new subscribers."
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Variables</h2>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setVariables((prev) => [...prev, blankVariable()])
                }
              >
                <Plus className="h-4 w-4" /> Add variable
              </Button>
            </div>
            {variables.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No variables. Add one if the emails need grounding inputs.
              </p>
            ) : (
              variables.map((v, i) => (
                <div
                  key={i}
                  className="grid gap-2 rounded-md border p-3 sm:grid-cols-2"
                >
                  <div className="space-y-1">
                    <Label htmlFor={`var-key-${i}`}>Key</Label>
                    <Input
                      id={`var-key-${i}`}
                      value={v.key}
                      onChange={(e) =>
                        updateVariable(i, { key: e.target.value })
                      }
                      placeholder="product_name"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`var-label-${i}`}>Label</Label>
                    <Input
                      id={`var-label-${i}`}
                      value={v.label}
                      onChange={(e) =>
                        updateVariable(i, { label: e.target.value })
                      }
                      placeholder="Product name"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`var-type-${i}`}>Type</Label>
                    <Select
                      id={`var-type-${i}`}
                      value={v.type}
                      onChange={(e) =>
                        updateVariable(i, {
                          type: e.target.value as TemplateVariable["type"],
                        })
                      }
                    >
                      <option value="text">text</option>
                      <option value="longtext">longtext</option>
                      <option value="url">url</option>
                      <option value="number">number</option>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`var-example-${i}`}>Example</Label>
                    <Input
                      id={`var-example-${i}`}
                      value={v.example}
                      onChange={(e) =>
                        updateVariable(i, { example: e.target.value })
                      }
                      placeholder="Moosewave"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={v.required}
                      onChange={(e) =>
                        updateVariable(i, { required: e.target.checked })
                      }
                    />
                    Required
                  </label>
                  <div className="flex items-end justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() =>
                        setVariables((prev) => prev.filter((_, j) => j !== i))
                      }
                    >
                      <Trash2 className="h-4 w-4" /> Remove
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Emails</h2>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setEmails((prev) => [...prev, blankEmail(prev.length + 1)])
                }
              >
                <Plus className="h-4 w-4" /> Add email
              </Button>
            </div>
            {emails.map((e, i) => (
              <div key={i} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Email #{i + 1}</h3>
                  {emails.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() =>
                        setEmails((prev) => prev.filter((_, j) => j !== i))
                      }
                    >
                      <Trash2 className="h-4 w-4" /> Remove
                    </Button>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`email-subj-${i}`}>Subject hint</Label>
                  <Input
                    id={`email-subj-${i}`}
                    value={e.subjectHint}
                    onChange={(ev) =>
                      updateEmail(i, { subjectHint: ev.target.value })
                    }
                    placeholder="Welcome to {product_name}"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`email-body-${i}`}>Body hint</Label>
                  <Textarea
                    id={`email-body-${i}`}
                    value={e.bodyHint}
                    onChange={(ev) =>
                      updateEmail(i, { bodyHint: ev.target.value })
                    }
                    rows={3}
                    placeholder="Introduce the product and set expectations."
                  />
                </div>
                <div className="space-y-1 sm:w-40">
                  <Label htmlFor={`email-delay-${i}`}>Delay (hours)</Label>
                  <Input
                    id={`email-delay-${i}`}
                    type="number"
                    min={0}
                    value={e.delayHours}
                    onChange={(ev) =>
                      updateEmail(i, { delayHours: Number(ev.target.value) })
                    }
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
          {!copyBlocked && !canSave ? (
            <p
              id="sequence-template-save-requirements"
              className="text-xs text-muted-foreground sm:mr-auto"
            >
              Still needed: {saveRequirements.join(", ")}.
            </p>
          ) : null}
          <Button asChild variant="ghost">
            <Link href={asRoute("/app/sequence-templates")}>Cancel</Link>
          </Button>
          <Button
            type="submit"
            disabled={copyBlocked || !canSave || saving}
            aria-describedby={
              copyBlocked
                ? "sequence-template-copy-state"
                : canSave
                  ? undefined
                  : "sequence-template-save-requirements"
            }
          >
            {saving ? "Creating…" : "Create template"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
