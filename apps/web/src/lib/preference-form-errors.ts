// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from "@/lib/api";

export function expiredPreferenceRoute(
  error: unknown,
  pathname: string,
): string | null {
  if (!(error instanceof ApiError) || error.status !== 410) return null;
  const match = /^(.*\/preferences)\/[^/]+\/?$/.exec(pathname);
  return match ? `${match[1]}/expired` : null;
}
