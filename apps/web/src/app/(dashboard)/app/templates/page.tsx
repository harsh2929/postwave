// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from "next/navigation";

import { ApiError, apiErrorMessage } from "@/lib/api";
import {
  searchCampaignTemplates,
  type CampaignTemplateSearchResponse,
} from "@/lib/campaign-templates-api";

import { TemplatesBrowser } from "./_components/browser";
import { LIBRARY_VIEW_SCOPES } from "./_components/library-view-scopes";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const EMPTY_RESULT: CampaignTemplateSearchResponse = {
  items: [],
  next_cursor: null,
  total: 0,
  facets: {},
};

const LIBRARY_FILTER_PARAMS = new Set([
  "view",
  "q",
  "goal",
  "category",
  "style",
  "industry",
  "layout",
  "source",
  "provider",
  "kind",
  "tag",
  "featured",
  "favorited",
  "sort",
  "archived",
]);

export default async function TemplatesPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const hasFilteredDeepLink = Object.keys(query).some((key) =>
    LIBRARY_FILTER_PARAMS.has(key),
  );
  let initialResult = EMPTY_RESULT;
  let loadError: string | null = null;
  let loadStatus: number | undefined;
  // The server seed is only valid for the canonical Inspiration view. A
  // filtered/private deep link starts empty and lets the client request its
  // exact URL state, so default public inspiration can never flash beneath a
  // Favorites/My templates request or linger if that request fails.
  if (!hasFilteredDeepLink) {
    // Exactly the Inspiration tab's scope — the platform catalog, every kind —
    // because the browser reuses this result only when its own state matches.
    const inspiration = LIBRARY_VIEW_SCOPES.inspiration;
    try {
      initialResult = await searchCampaignTemplates({
        goal: inspiration.goal,
        source: inspiration.source,
        sort: "recommended",
        page: 1,
        perPage: 24,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        redirect("/login?next=%2Fapp%2Ftemplates");
      }
      if (error instanceof ApiError) loadStatus = error.status;
      loadError = apiErrorMessage(error, "Templates could not be loaded.");
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-[1500px] space-y-8 p-4 sm:p-6 lg:p-8">
      <TemplatesBrowser
        initialResult={initialResult}
        initialLoadError={loadError}
        initialLoadStatus={loadStatus}
        initialRequiresRefresh={hasFilteredDeepLink}
        autoOpenGenerate={
          (Array.isArray(query.generate)
            ? query.generate[0]
            : query.generate) === "1"
        }
      />
    </div>
  );
}
