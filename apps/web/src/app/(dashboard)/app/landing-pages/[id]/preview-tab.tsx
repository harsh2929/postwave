// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  buildPreviewHtml,
  type LandingContent,
} from "@/lib/landing-page-content";

export function PreviewTab({
  content,
  template,
  name,
}: {
  content: LandingContent;
  template: string;
  name: string;
}) {
  const previewHtml = buildPreviewHtml(content, { template, name });

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        A private preview of the current draft — visible only to you, not
        reachable by a public URL. The signup form is inactive in preview and
        will not submit.
      </p>
      <div className="overflow-hidden rounded-md border bg-white">
        <iframe
          // Empty sandbox + srcDoc isolates authored HTML from the admin
          // origin: no scripts, navigation, forms, or ambient credentials.
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={previewHtml}
          title="Landing page preview"
          className="h-[70vh] w-full"
        />
      </div>
    </div>
  );
}
