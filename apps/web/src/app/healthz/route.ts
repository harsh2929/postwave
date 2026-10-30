// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Process liveness for the web container and its ALB target group.
 *
 * This endpoint deliberately does not call the API, database, or any external
 * provider. Upstream dependency readiness is checked before rollout and by
 * its owning service; coupling it here would recycle healthy Next.js tasks
 * during an API incident and amplify the outage.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = {
  "cache-control": "no-store, max-age=0",
  "content-type": "application/json; charset=utf-8",
} as const;

export function GET(): Response {
  return new Response('{"status":"ok","service":"postwave-web"}', {
    status: 200,
    headers: HEADERS,
  });
}

export function HEAD(): Response {
  return new Response(null, { status: 200, headers: HEADERS });
}
