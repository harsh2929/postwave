// SPDX-License-Identifier: AGPL-3.0-only

import { NextResponse, type NextRequest } from "next/server";

import { contentSecurityPolicy } from "./lib/csp";
import { sessionCookieOnly } from "./lib/opsSecurity";

// Container liveness/readiness must answer before any operator has signed in.
// Everything else this console serves is operator-only.
const UNAUTHENTICATED_PATHS = new Set(["/api/health", "/api/ready"]);

// Deliberately script-free and style-free so it renders identically under the
// console's own nonce policy. There is no sign-in form here: the session is
// minted by the dashboard and this console only ever forwards it.
const SIGN_IN_REQUIRED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Operator sign-in required</title></head>
<body><h1>Operator sign-in required</h1>
<p>This console forwards an existing Moosewave operator session. Sign in to the
dashboard on this domain, then reload.</p></body></html>
`;

export function middleware(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV !== "production");
  const { pathname } = request.nextUrl;

  // Fail closed before any handler can call upstream. A request carrying no
  // structurally valid pw_session can only ever earn a 401 from the API — but
  // it earns it *after* the ops rate limiter, which is mounted ahead of
  // authentication and keyed by IP, so unauthenticated traffic would otherwise
  // drain the single budget every operator shares and darken the console
  // exactly when an incident needs it. apps/web/src/middleware.ts refuses
  // /app/* the same way, for the same reason.
  if (
    !UNAUTHENTICATED_PATHS.has(pathname) &&
    !sessionCookieOnly(request.headers.get("cookie"))
  ) {
    return signInRequired(pathname, policy);
  }

  const requestHeaders = new Headers(request.headers);

  // Next reads the nonce from the incoming CSP and applies it to framework,
  // page, and hydration scripts. Supplying it per request avoids the broad
  // unsafe-inline escape hatch on this privileged control plane.
  requestHeaders.set("content-security-policy", policy);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", policy);
  return response;
}

// A short-circuited response never reaches next.config.mjs's header pass, so
// the headers that matter for a refusal are set here rather than inherited.
function signInRequired(pathname: string, policy: string): NextResponse {
  const json = pathname.startsWith("/api/");
  const response = new NextResponse(
    json
      ? JSON.stringify({
          error: {
            code: "operator_session_required",
            message: "operator authentication is required",
          },
        })
      : SIGN_IN_REQUIRED_HTML,
    { status: 401 },
  );
  response.headers.set(
    "content-type",
    json ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
  );
  response.headers.set("cache-control", "no-store");
  response.headers.set("content-security-policy", policy);
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
