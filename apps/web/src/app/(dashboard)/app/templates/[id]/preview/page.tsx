// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowLeft, Send, ShieldCheck } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  campaignTemplateHostedPreviewAssets,
  getCampaignTemplate,
} from "@/lib/campaign-templates-api";
import { handleCampaignTemplateRouteError } from "@/lib/campaign-template-route-error";
import { asRoute } from "@/lib/typed-routes";

import { MjmlPreviewLazy } from "../../_components/mjml-preview-lazy";
import { TemplateCapturePreview } from "../../_components/template-capture-preview";
import { TemplateHeaderAction } from "../../_components/template-header-action-lazy";

// The sidebar's pre-flight card and test-send dialog are secondary to the
// preview canvas, so they are split out of the eager route graph (bundle
// budget). Each fallback keeps the silhouette of what it stands in for.
// The HTML-only sandbox (compiled-HTML designs without MJML source) is the
// degraded preview path, so its frame + canvas controls load on demand too;
// the MJML canvas itself is split behind MjmlPreviewLazy (a client wrapper,
// since a boundary declared in this server page stays in the eager graph).
const TemplatePreviewWithVars = dynamic(
  () =>
    import("../../_components/template-preview-with-vars").then(
      (module) => module.TemplatePreviewWithVars,
    ),
  {
    loading: () => (
      <div
        role="status"
        aria-label="Loading HTML preview"
        className="space-y-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-20" />
        </div>
        <Skeleton className="h-[480px] w-full" />
      </div>
    ),
  },
);

const TemplatePreflightCard = dynamic(
  () =>
    import("../../_components/template-preflight-card").then(
      (module) => module.TemplatePreflightCard,
    ),
  {
    loading: () => (
      <Card role="status" aria-label="Loading pre-flight checks">
        <CardContent className="space-y-3 p-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    ),
  },
);

const ContentTestSendDialog = dynamic(
  () =>
    import("@/components/content-test-send-dialog").then(
      (module) => module.ContentTestSendDialog,
    ),
  {
    loading: () => (
      <Skeleton
        className="h-9 w-full"
        role="status"
        aria-label="Loading test send"
      />
    ),
  },
);

interface PageProps {
  params: Promise<{ id: string }>;
}

function InboxRealityCta() {
  return (
    <div className="rounded-lg border bg-muted/30 p-4 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
        Verify inbox placement
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Client simulations are approximations. Run an Inbox Reality check to see
        real placement and spam signals across seed inboxes.
      </p>
      <Button asChild variant="outline" size="sm" className="mt-3">
        <Link href={asRoute("/app/inbox-reality/predict")}>
          Open Inbox Reality
        </Link>
      </Button>
    </div>
  );
}

export default async function TemplateClientPreviewPage({ params }: PageProps) {
  const { id } = await params;
  let template;
  try {
    template = await getCampaignTemplate(id);
  } catch (error) {
    handleCampaignTemplateRouteError(error, `/app/templates/${id}/preview`);
  }

  const preflightSource =
    template.template_kind === "reference"
      ? ""
      : template.body_mjml?.trim() || template.body_html?.trim() || "";
  const hostedPreviews = campaignTemplateHostedPreviewAssets(template);

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="ghost" className="-ml-3">
          <Link href={`/app/templates/${template.id}`}>
            <ArrowLeft className="h-4 w-4" />
            {template.name}
          </Link>
        </Button>
        <TemplateHeaderAction
          template={template}
          label={
            template.template_kind === "reference"
              ? "Make it mine"
              : "Use template"
          }
        />
      </div>

      <header>
        <div className="mb-2 flex flex-wrap gap-2">
          <Badge variant="outline">Preview</Badge>
          {template.template_kind !== "reference" && template.body_mjml ? (
            <Badge variant="secondary">MJML source</Badge>
          ) : null}
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Inbox client preview
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {template.template_kind === "reference"
            ? "Inspect each independently hosted desktop, card, or mobile capture that is available for this reference."
            : "Inspect desktop, mobile, and dark canvases. Client simulations are approximations; send a test to real inboxes before production use."}
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section
          aria-labelledby="preview-heading"
          className="min-w-0 space-y-3"
        >
          <h2 id="preview-heading" className="sr-only">
            Client preview
          </h2>
          {template.template_kind === "reference" ? (
            hostedPreviews.length ? (
              <>
                <Alert>
                  <AlertTitle>Reference design</AlertTitle>
                  <AlertDescription>
                    This hosted, sanitized image is visual inspiration rather
                    than reusable source. Choose Make it mine to create
                    original, editable HTML/MJML.
                  </AlertDescription>
                </Alert>
                <TemplateCapturePreview
                  assets={hostedPreviews}
                  templateName={template.name}
                  expanded
                />
              </>
            ) : (
              <Alert>
                <AlertTitle>Hosted preview unavailable</AlertTitle>
                <AlertDescription>
                  This inspiration record remains metadata-only until Moosewave
                  has a reviewed, sanitized hosted capture. Captured provider
                  markup and image URLs are intentionally not rendered.
                </AlertDescription>
              </Alert>
            )
          ) : template.body_mjml?.trim() ? (
            <MjmlPreviewLazy
              mjml={template.body_mjml}
              variables={template.variables}
            />
          ) : template.body_html?.trim() ? (
            <>
              <Alert variant="warning">
                <AlertTitle>HTML-only template</AlertTitle>
                <AlertDescription>
                  Multi-client MJML simulation is unavailable because this
                  design only stores compiled HTML. The sandbox below still
                  supports desktop, mobile, and dark canvases.
                </AlertDescription>
              </Alert>
              <TemplatePreviewWithVars
                html={template.body_html}
                title={`${template.name} preview`}
                variables={template.variables}
              />
            </>
          ) : hostedPreviews.length ? (
            <TemplateCapturePreview
              assets={hostedPreviews}
              templateName={template.name}
              expanded
            />
          ) : (
            <Alert variant="destructive">
              <AlertTitle>No editable source</AlertTitle>
              <AlertDescription>
                This catalog record has no HTML or MJML source to preview.
              </AlertDescription>
            </Alert>
          )}
        </section>

        <aside className="space-y-4">
          {preflightSource ? (
            <>
              <TemplatePreflightCard
                source={preflightSource}
                context={{
                  subject: template.subject ?? "",
                  previewText: template.preview_text ?? "",
                  compiledHtml: template.body_html?.trim() || null,
                }}
              />
              {/* TMPL-022: send a render check to your own inbox. Subject falls
                  back to the template name (the endpoint requires one). */}
              <ContentTestSendDialog
                content={{
                  subject: template.subject?.trim() || template.name,
                  body_mjml: template.body_mjml || undefined,
                  body_html: template.body_html || undefined,
                }}
                trigger={
                  <Button variant="outline" className="w-full">
                    <Send className="h-4 w-4" />
                    Send a test to my inbox
                  </Button>
                }
              />
            </>
          ) : null}
          <InboxRealityCta />
        </aside>
      </div>
    </div>
  );
}
