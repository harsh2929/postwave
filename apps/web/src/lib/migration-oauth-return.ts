import type { Route } from "next";

import type { SourcePlatform } from "./types";

export type MigrationOAuthReturnStep = "review" | "detail" | undefined;

export function migrationOAuthReturnPath(
  source: SourcePlatform,
  jobId: string,
  returnStep: MigrationOAuthReturnStep,
  desktopReturn: boolean,
): Route {
  const encodedJobId = encodeURIComponent(jobId);
  if (desktopReturn) {
    return `/app/migrations?desktop_handoff=complete&job_id=${encodedJobId}` as Route;
  }
  if (returnStep === "detail") {
    return `/app/migrations/${encodedJobId}` as Route;
  }
  return `/app/migrations/new/${source}?step=${returnStep === "review" ? "review" : "discover"}&job_id=${encodedJobId}` as Route;
}
