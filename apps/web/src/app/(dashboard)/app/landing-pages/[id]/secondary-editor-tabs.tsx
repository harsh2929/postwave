// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { Copy, Users, Workflow } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { slugify } from "@/lib/slugify";
import {
  SEO_DESCRIPTION_MAX,
  SEO_TITLE_MAX,
  type SeoErrors,
  type SeoFields,
} from "@/lib/landing-page-content";

const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const TEMPLATES = [
  "signup",
  "waitlist",
  "event",
  "product",
  "coming-soon",
  "custom",
] as const;

export interface LandingSecondaryEditorModel {
  name: string;
  slug: string;
  template: string;
  domain: string;
  seo: SeoFields;
  publishAt: string;
  unpublishAt: string;
}

interface SecondaryEditorTabProps {
  kind: "seo" | "settings";
  model: LandingSecondaryEditorModel;
  seoErrors: SeoErrors;
  url: string;
  scheduleInvalid: boolean;
  readOnly: boolean;
  onPatchSeo: (patch: Partial<SeoFields>) => void;
  onPatchModel: (patch: Partial<LandingSecondaryEditorModel>) => void;
  onCopyUrl: () => void;
}

export function LandingSecondaryEditorTab(props: SecondaryEditorTabProps) {
  return props.kind === "seo" ? (
    <SeoTab {...props} />
  ) : (
    <SettingsTab {...props} />
  );
}

function SeoTab({
  model,
  seoErrors,
  url,
  readOnly,
  onPatchSeo,
}: SecondaryEditorTabProps) {
  return (
    <section className="space-y-4 rounded-md border bg-card p-4">
      <p className="text-xs text-muted-foreground">
        These populate the public page&apos;s title, meta description, canonical
        URL and social preview. Blank fields fall back to the page name and hero
        copy.
      </p>
      <div>
        <Label htmlFor="seo-title" className="mb-1 block text-muted-foreground">
          Title{" "}
          <span
            className={
              model.seo.title.trim().length > SEO_TITLE_MAX
                ? "text-destructive"
                : ""
            }
          >
            ({model.seo.title.trim().length}/{SEO_TITLE_MAX})
          </span>
        </Label>
        <Input
          id="seo-title"
          disabled={readOnly}
          value={model.seo.title}
          onChange={(event) => onPatchSeo({ title: event.target.value })}
          placeholder={model.name}
          aria-invalid={seoErrors.title ? true : undefined}
          aria-describedby={seoErrors.title ? "seo-title-error" : undefined}
        />
        {seoErrors.title ? (
          <p
            id="seo-title-error"
            role="alert"
            className="mt-1 text-xs text-destructive"
          >
            {seoErrors.title}
          </p>
        ) : null}
      </div>
      <div>
        <Label
          htmlFor="seo-description"
          className="mb-1 block text-muted-foreground"
        >
          Meta description{" "}
          <span
            className={
              model.seo.description.trim().length > SEO_DESCRIPTION_MAX
                ? "text-destructive"
                : ""
            }
          >
            ({model.seo.description.trim().length}/{SEO_DESCRIPTION_MAX})
          </span>
        </Label>
        <Textarea
          id="seo-description"
          disabled={readOnly}
          value={model.seo.description}
          onChange={(event) => onPatchSeo({ description: event.target.value })}
          placeholder="A short summary shown in search results and link previews."
          rows={3}
          aria-invalid={seoErrors.description ? true : undefined}
          aria-describedby={
            seoErrors.description ? "seo-description-error" : undefined
          }
        />
        {seoErrors.description ? (
          <p
            id="seo-description-error"
            role="alert"
            className="mt-1 text-xs text-destructive"
          >
            {seoErrors.description}
          </p>
        ) : null}
      </div>
      <div>
        <Label
          htmlFor="seo-canonical"
          className="mb-1 block text-muted-foreground"
        >
          Canonical URL
        </Label>
        <Input
          id="seo-canonical"
          disabled={readOnly}
          value={model.seo.canonical}
          onChange={(event) => onPatchSeo({ canonical: event.target.value })}
          placeholder={url}
          inputMode="url"
          aria-invalid={seoErrors.canonical ? true : undefined}
          aria-describedby={
            seoErrors.canonical ? "seo-canonical-error" : undefined
          }
        />
        {seoErrors.canonical ? (
          <p
            id="seo-canonical-error"
            role="alert"
            className="mt-1 text-xs text-destructive"
          >
            {seoErrors.canonical}
          </p>
        ) : null}
      </div>
      <div>
        <Label htmlFor="seo-og" className="mb-1 block text-muted-foreground">
          Social image URL
        </Label>
        <Input
          id="seo-og"
          disabled={readOnly}
          value={model.seo.ogImage}
          onChange={(event) => onPatchSeo({ ogImage: event.target.value })}
          placeholder="https://…/preview.png"
          inputMode="url"
          aria-invalid={seoErrors.ogImage ? true : undefined}
          aria-describedby={
            seoErrors.ogImage ? "seo-social-image-error" : undefined
          }
        />
        {seoErrors.ogImage ? (
          <p
            id="seo-social-image-error"
            role="alert"
            className="mt-1 text-xs text-destructive"
          >
            {seoErrors.ogImage}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function SettingsTab({
  model,
  scheduleInvalid,
  readOnly,
  onPatchModel,
  onCopyUrl,
}: SecondaryEditorTabProps) {
  return (
    <>
      <section className="space-y-4 rounded-md border bg-card p-4">
        <div>
          <Label
            htmlFor="set-name"
            className="mb-1 block text-muted-foreground"
          >
            Name
          </Label>
          <Input
            id="set-name"
            disabled={readOnly}
            value={model.name}
            onChange={(event) => onPatchModel({ name: event.target.value })}
            maxLength={200}
          />
        </div>
        <div>
          <Label
            htmlFor="set-template"
            className="mb-1 block text-muted-foreground"
          >
            Template
          </Label>
          <Select
            id="set-template"
            disabled={readOnly}
            value={
              TEMPLATES.includes(model.template as (typeof TEMPLATES)[number])
                ? model.template
                : "custom"
            }
            onChange={(event) => onPatchModel({ template: event.target.value })}
          >
            {TEMPLATES.map((template) => (
              <option key={template} value={template}>
                {template.charAt(0).toUpperCase() +
                  template.slice(1).replace(/-/g, " ")}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label
            htmlFor="set-domain"
            className="mb-1 block text-muted-foreground"
          >
            Custom domain <span className="text-xs">(optional)</span>
          </Label>
          <Input
            id="set-domain"
            disabled={readOnly}
            value={model.domain}
            onChange={(event) => onPatchModel({ domain: event.target.value })}
            placeholder="pages.example.com"
            inputMode="url"
          />
        </div>
        <div>
          <Label
            htmlFor="set-slug"
            className="mb-1 block text-muted-foreground"
          >
            Slug (public URL)
          </Label>
          <div className="flex items-center gap-2">
            <span className="shrink-0 rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
              /landing/
            </span>
            <Input
              id="set-slug"
              disabled={readOnly}
              value={model.slug}
              onChange={(event) =>
                onPatchModel({ slug: slugify(event.target.value) })
              }
              className="font-mono"
              aria-invalid={!SLUG_PATTERN.test(model.slug.trim())}
              aria-describedby={
                model.slug.trim() && !SLUG_PATTERN.test(model.slug.trim())
                  ? "landing-page-slug-error"
                  : "landing-page-slug-hint"
              }
            />
            <IconButton
              aria-label="Copy public URL"
              size="sm"
              onClick={onCopyUrl}
            >
              <Copy className="h-3.5 w-3.5" />
            </IconButton>
          </div>
          {model.slug.trim() && !SLUG_PATTERN.test(model.slug.trim()) ? (
            <p
              id="landing-page-slug-error"
              role="alert"
              className="mt-1 text-xs text-destructive"
            >
              Start with a letter; lowercase letters, numbers, and hyphens only.
            </p>
          ) : (
            <p
              id="landing-page-slug-hint"
              className="mt-1 text-xs text-muted-foreground"
            >
              Renaming changes the public URL. Existing links to the old slug
              will stop resolving.
            </p>
          )}
        </div>
      </section>

      <section className="space-y-4 rounded-md border bg-card p-4">
        <div>
          <h2 className="text-sm font-semibold">Schedule</h2>
          <p className="text-xs text-muted-foreground">
            Optionally publish or auto-unpublish (expire) this page at a set
            time. Times are in your local timezone. Save to apply.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label
              htmlFor="sched-publish"
              className="mb-1 block text-muted-foreground"
            >
              Publish at
            </Label>
            <Input
              id="sched-publish"
              disabled={readOnly}
              type="datetime-local"
              value={model.publishAt}
              onChange={(event) =>
                onPatchModel({ publishAt: event.target.value })
              }
              aria-invalid={scheduleInvalid || undefined}
              aria-describedby={
                scheduleInvalid
                  ? "landing-page-schedule-error"
                  : "landing-page-publish-hint"
              }
            />
            <p
              id="landing-page-publish-hint"
              className="mt-1 text-[11px] text-muted-foreground"
            >
              A draft flips to published automatically at this time.
            </p>
          </div>
          <div>
            <Label
              htmlFor="sched-unpublish"
              className="mb-1 block text-muted-foreground"
            >
              Auto-unpublish at
            </Label>
            <Input
              id="sched-unpublish"
              disabled={readOnly}
              type="datetime-local"
              value={model.unpublishAt}
              onChange={(event) =>
                onPatchModel({ unpublishAt: event.target.value })
              }
              aria-invalid={scheduleInvalid || undefined}
              aria-describedby={
                scheduleInvalid
                  ? "landing-page-schedule-error"
                  : "landing-page-unpublish-hint"
              }
            />
            <p
              id="landing-page-unpublish-hint"
              className="mt-1 text-[11px] text-muted-foreground"
            >
              A published page reverts to draft at this time.
            </p>
          </div>
        </div>
        {scheduleInvalid ? (
          <p
            id="landing-page-schedule-error"
            role="alert"
            className="text-xs text-destructive"
          >
            Publish time must be earlier than the auto-unpublish time.
          </p>
        ) : null}
      </section>

      <section className="space-y-3 rounded-md border bg-card p-4">
        <h2 className="text-sm font-semibold">After signup</h2>
        <p className="text-xs text-muted-foreground">
          Leads captured by this page are added to your subscribers with the
          source <code>landing_page</code>. Follow up automatically with a
          welcome flow.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/app/subscribers">
              <Users className="h-4 w-4" />
              View acquired subscribers
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/app/flows">
              <Workflow className="h-4 w-4" />
              Connect a welcome flow
            </Link>
          </Button>
        </div>
      </section>
    </>
  );
}
