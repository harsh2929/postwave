// SPDX-License-Identifier: AGPL-3.0-only
//
// `/app/inbound-webhooks/<id>` — the canonical per-webhook address.
//
// This route did not exist. The only page under `[id]` was `triggers/page.tsx`,
// and the list page links directly to `/app/inbound-webhooks/<id>/triggers`
// (page.tsx:512), so the app worked while the shared address did not:
// @postwave/route-map addresses every entity as `/app/<slug>/<id>`, which
// Next.js answered with a 404 for this one. `copy link`, the activity feed and
// the resume card all mint that shape.
//
// Rather than teach the registry a per-entity "detail lives one level deeper"
// exception — which every future link producer would have to remember — the
// canonical address resolves to the page that IS the webhook's detail view.
// `replace` keeps the 404-shaped URL out of history so Back returns to wherever
// the user came from, not to a redirect hop.
import { redirect, RedirectType } from "next/navigation";

import { isSafeResourceId } from "@postwave/route-map";

export default async function InboundWebhookDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Validate with the SAME predicate that minted the link, so an id this
  // registry would never produce never reaches a downstream route.
  if (!isSafeResourceId(id)) redirect("/app/inbound-webhooks");
  redirect(
    `/app/inbound-webhooks/${encodeURIComponent(id)}/triggers`,
    RedirectType.replace,
  );
}
