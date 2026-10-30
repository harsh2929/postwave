// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import {
  legalDraftPreviewAllowed,
  legalPublicationApproved,
} from "@/lib/legal-publication";

// Unapproved legal documents remain unpublished. Loopback requests to the
// development server can read the drafts while exercising authentication and
// consent links; a local preview never supplies a publication approval record.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<JSX.Element> {
  const approved = legalPublicationApproved();
  const preview =
    !approved && legalDraftPreviewAllowed((await headers()).get("host"));
  if (!approved && !preview) notFound();

  return (
    <>
      {preview ? (
        <aside
          aria-label="Legal draft preview"
          className="mx-auto mt-8 max-w-3xl rounded-xl border border-mw-ink/15 bg-mw-yellow/15 px-6 py-4 text-sm text-mw-ink"
        >
          <p className="font-semibold">Draft for local review</p>
          <p className="mt-1">
            These policies are drafts pending legal review. They are available
            here for local testing and have not been approved for publication.
          </p>
        </aside>
      ) : null}
      {children}
    </>
  );
}
