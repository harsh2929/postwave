// SPDX-License-Identifier: AGPL-3.0-only
//
// Public hosted form page. Looks up the form by slug via the gateway's
// /api/public/forms/:slug endpoint (no auth, no tenant header). Renders
// using `compileFormHtml`, with the form action pointed at the public
// submit endpoint.
//
// 404s for missing forms AND for forms in any non-published state — there
// is no information leak about whether a draft exists.
import { notFound } from "next/navigation";
import Script from "next/script";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { SurveyForm } from "@/components/SurveyForm";
import { HostedCompiledForm } from "@/components/HostedCompiledForm";
import { compileFormHtml, isSurvey } from "@/lib/forms-types";
import { fetchPublicForm } from "@/lib/public-pages-api";

export default async function PublicFormPage({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}) {
  const { slug, locale } = await params;
  // Pin the request locale so getTranslations resolves against this segment.
  setRequestLocale(locale);
  const [result, t, tCommon] = await Promise.all([
    fetchPublicForm(slug),
    getTranslations("forms"),
    getTranslations("common"),
  ]);
  if (result.kind === "unavailable") {
    return (
      <PublicUnavailable
        title={t("unavailable_title")}
        body={t("unavailable_body")}
      />
    );
  }
  if (result.kind !== "ok") notFound();
  const form = result.data;
  if (!form || form.status !== "published") notFound();

  const actionUrl = `/api/public/forms/${encodeURIComponent(form.slug)}/submit`;

  // Multi-step survey forms render through the React wizard; legacy
  // single-step forms keep going through the compiled-HTML path so
  // they remain 1:1 identical to the iframe embed (and JS-off works).
  if (isSurvey(form.structure)) {
    return (
      <div className="space-y-4 rounded-2xl border bg-card p-5 shadow-sm sm:p-8">
        <h1 className="sr-only">{publicFormTitle(form)}</h1>
        {form.captchaRequired ? (
          <Script
            src="https://www.google.com/recaptcha/api.js"
            strategy="afterInteractive"
          />
        ) : null}
        <SurveyForm form={form} actionUrl={actionUrl} />
        <p className="text-center text-xs leading-5 text-muted-foreground">
          {form.optInMode === "double"
            ? t("double_optin_notice")
            : t("submitted_notice")}
        </p>
      </div>
    );
  }

  const html = compileFormHtml(form, {
    actionUrl,
    includeCaptchaScript: false,
    selectPlaceholder: t("select_placeholder"),
    noOptionsMessage: t("no_options"),
  });

  return (
    <div className="space-y-4 rounded-2xl border bg-card p-5 shadow-sm sm:p-8">
      <h1 className="sr-only">{publicFormTitle(form)}</h1>
      {form.captchaRequired ? (
        <Script
          src="https://www.google.com/recaptcha/api.js"
          strategy="afterInteractive"
        />
      ) : null}
      {/* The client wrapper preserves the compiled markup while adding the
          durable paid-verification retry token and bounded JSON transport. */}
      <HostedCompiledForm html={html} actionURL={actionUrl} slug={form.slug} />
      <p className="text-center text-xs leading-5 text-muted-foreground">
        {tCommon("respect_inbox")}{" "}
        {form.optInMode === "double"
          ? t("double_optin_notice")
          : t("single_optin_notice")}
      </p>
    </div>
  );
}

function PublicUnavailable({ title, body }: { title: string; body: string }) {
  return (
    <div className="space-y-3 rounded-2xl border bg-card p-6 text-center shadow-sm sm:p-8">
      <h1 className="break-words text-xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="break-words text-sm leading-6 text-muted-foreground">
        {body}
      </p>
    </div>
  );
}

function publicFormTitle(form: {
  slug: string;
  structure: {
    fields: Array<{ kind: string; label: string; content?: string }>;
  };
}): string {
  const heading = form.structure.fields.find(
    (field) => field.kind === "heading",
  );
  const authored = heading?.content?.trim() || heading?.label.trim();
  if (authored) return authored.slice(0, 240);
  return form.slug.replace(/[-_]+/g, " ");
}
