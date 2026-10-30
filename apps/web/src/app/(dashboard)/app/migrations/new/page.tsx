// SPDX-License-Identifier: AGPL-3.0-only
//
// Bare `/app/migrations/new` used to render a SECOND, hand-maintained source
// picker with a hardcoded 12-source list that drifted from the live
// capability-driven catalogue on `/app/migrations` (it was already 8 sources
// out of date). Nothing in the UI linked here — it was reachable only by URL —
// so we redirect it to the single, capability-driven picker (MIGR-016).

import { redirect } from "next/navigation";

export default function NewMigrationRedirectPage(): never {
  redirect("/app/migrations");
}
