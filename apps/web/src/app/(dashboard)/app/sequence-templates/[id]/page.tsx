// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getTemplate } from "@/lib/voice-api";
import { ApiError } from "@/lib/api";
import { asRoute } from "@/lib/typed-routes";
import type { SequenceTemplate } from "@/lib/voice-types";
import { compactProse } from "@/styles/compact-prose";

const MARKDOWN_ALLOWED = [
  "p",
  "strong",
  "em",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "blockquote",
  "a",
  "h1",
  "h2",
  "h3",
  "h4",
  "br",
  "hr",
];

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function SequenceTemplateDetailPage({
  params,
}: PageProps) {
  const { id } = await params;
  let template: SequenceTemplate;
  try {
    template = await getTemplate(id);
  } catch (error) {
    // Only a genuine 404 is "not found". A transient 500/timeout must not be
    // disguised as a missing template — surface it with a retry path.
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }
    const message =
      error instanceof Error
        ? error.message
        : "The sequence template could not be loaded.";
    return (
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4 p-4 sm:p-6 lg:p-8">
        <Button asChild variant="ghost" className="-ml-3">
          <Link href={asRoute("/app/sequence-templates")}>
            <ArrowLeft className="h-4 w-4" />
            Sequence templates
          </Link>
        </Button>
        <Card>
          <CardContent
            role="alert"
            className="flex flex-col items-start gap-3 p-6 text-sm"
          >
            <div>
              <h1 className="font-medium text-foreground">
                Couldn&apos;t load this template
              </h1>
              <p className="mt-1 text-muted-foreground">{message}</p>
            </div>
            <Button asChild variant="outline" size="sm">
              <a href={asRoute(`/app/sequence-templates/${id}`)}>Try again</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
      <Button asChild variant="ghost" className="-ml-3">
        <Link href={asRoute("/app/sequence-templates")}>
          <ArrowLeft className="h-4 w-4" />
          Sequence templates
        </Link>
      </Button>

      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div className="max-w-3xl">
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{template.category}</Badge>
            <span>{template.length} emails</span>
          </div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            {template.name}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {template.description}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link
              href={asRoute(`/app/sequence-templates/new?from=${template.id}`)}
            >
              Duplicate
            </Link>
          </Button>
          <Button asChild className="w-full sm:w-auto">
            <Link href={`/app/sequences/new/${template.id}`}>
              Use this sequence
            </Link>
          </Button>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardContent className="space-y-3 p-4 sm:p-5">
            <h2 className="font-medium">Variables</h2>
            {template.variables.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No grounding variables are required for this template.
              </p>
            ) : (
              <ul className="space-y-3">
                {template.variables.map((variable) => (
                  <li key={variable.key} className="space-y-0.5">
                    <p className="text-sm font-medium">
                      {variable.label}
                      {variable.required ? (
                        <span className="ml-1 text-destructive">*</span>
                      ) : null}
                    </p>
                    <p className="break-words text-xs text-muted-foreground">
                      {variable.description}
                    </p>
                    <p className="break-words text-xs italic text-muted-foreground">
                      e.g. {variable.example}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-3">
          {template.emails.length === 0 ? (
            <Card>
              <CardContent className="p-4 text-sm text-muted-foreground sm:p-5">
                This template has no email steps yet.
              </CardContent>
            </Card>
          ) : (
            template.emails.map((email) => (
              <Card key={email.position}>
                <CardContent className="space-y-3 p-4 sm:p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="font-medium">Email #{email.position}</h2>
                    <span className="text-xs text-muted-foreground">
                      {email.delayHours === 0
                        ? "Send immediately"
                        : `Send ${email.delayHours}h after previous`}
                    </span>
                  </div>
                  <p className="break-words text-sm">
                    <span className="text-muted-foreground">
                      Subject hint:{" "}
                    </span>
                    <span className="font-medium">{email.subjectHint}</span>
                  </p>
                  <div
                    className={`${compactProse.root} ${compactProse.small} ${compactProse.invertDark} max-w-none break-words`}
                  >
                    <ReactMarkdown
                      allowedElements={MARKDOWN_ALLOWED}
                      urlTransform={defaultUrlTransform}
                      components={{
                        h1: ({ children }) => <h3>{children}</h3>,
                        h2: ({ children }) => <h3>{children}</h3>,
                        h3: ({ children }) => <h4>{children}</h4>,
                      }}
                    >
                      {email.bodyHint}
                    </ReactMarkdown>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
