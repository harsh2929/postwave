// SPDX-License-Identifier: AGPL-3.0-only

import { notFound, redirect } from "next/navigation";

import { ApiError } from "@/lib/api";

/**
 * Preserve the distinction between a missing template and a request that could
 * succeed on retry. Next's nearest route error boundary owns transient and
 * authorization failures; only an authoritative 404 becomes a not-found page.
 */
export function handleCampaignTemplateRouteError(
  error: unknown,
  nextPath: string,
): never {
  if (error instanceof ApiError && error.status === 401) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
  if (error instanceof ApiError && error.status === 404) {
    notFound();
  }
  throw error;
}
