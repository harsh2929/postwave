// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/middleware", () => ({
  default: () => (request: Request) => {
    const locale = new URL(request.url).pathname.split("/")[1] || "en";
    return new Response(null, {
      headers: {
        "x-middleware-override-headers": "x-next-intl-locale",
        "x-middleware-request-x-next-intl-locale": locale,
      },
    });
  },
}));

import { POST } from "@/app/api/csp-report/route";
import { sanitizeCSPReport } from "@/app/api/csp-report/sanitize";
import { middleware } from "@/middleware";
import {
  DOCUMENT_LOCALE_SCRIPT,
  ROOT_LAYOUT_SCRIPT_HASHES,
  THEME_SCRIPT,
} from "@/lib/root-layout-scripts";

/** A policy as directive name → its sources. */
function directivesOf(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((directive) => {
      const [name = "", ...sources] = directive.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
}

/** The nonce value a policy's script-src names, if any. */
function nonceOf(policy: string): string | undefined {
  const scriptSources = directivesOf(policy).get("script-src") ?? [];
  const source = scriptSources.find((value) => value.startsWith("'nonce-"));
  return source?.slice("'nonce-".length, -1);
}

describe("web CSP enforcement", () => {
  it("ships an enforced baseline plus a report-only tightening policy", () => {
    const config = readFileSync(
      new URL("../../next.config.mjs", import.meta.url),
      "utf8",
    );
    expect(config).toContain('key: "Content-Security-Policy"');
    expect(config).toContain('key: "Content-Security-Policy-Report-Only"');
    expect(config).toContain("\"base-uri 'none'\"");
    expect(config).toContain("\"object-src 'none'\"");
    expect(config).toContain('"report-uri /api/csp-report"');
    expect(config).not.toContain("connect-src 'self' https: wss:");
    expect(config).toContain("value: sensitiveCSP");
    expect(config).toContain("value: sensitiveCandidateCSP");
    expect(config).not.toContain("value: \"frame-ancestors 'none'\"");
    expect(config).toContain('sri: { algorithm: "sha384" }');
    expect(config).toContain('process.env.NODE_ENV === "development"');
    expect(config).not.toContain("https://s3.*.amazonaws.com");
    expect(config).not.toContain("\"img-src 'self' data: blob: https:\"");
    expect(config).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(config).toContain(
      "sentryDsnOrigin(process.env.NEXT_PUBLIC_SENTRY_DSN_WEB)",
    );
    expect(config).toContain(
      "configuredOrigin(process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL)",
    );
  });

  it("allows template pixels only from the exact configured Moosewave asset origin", () => {
    const previous = process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL;
    process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL =
      "https://assets.postwave.test/hosted";
    try {
      const response = middleware(
        new NextRequest("https://app.example/app/templates", {
          headers: { cookie: "pw_session=authenticated" },
        }),
      );
      const policy = response.headers.get("content-security-policy") ?? "";
      const imagePolicy =
        policy
          .split(";")
          .find((directive) => directive.trim().startsWith("img-src")) ?? "";
      expect(imagePolicy.split(/\s+/)).toContain(
        "https://assets.postwave.test",
      );
      expect(imagePolicy.split(/\s+/)).not.toContain("https:");
      expect(imagePolicy).not.toContain("really-good-emails");

      const archive = middleware(
        new NextRequest("https://app.example/en/archive/workspace/newsletter", {
          headers: { accept: "text/html" },
        }),
      );
      const archiveImagePolicy =
        (archive.headers.get("content-security-policy") ?? "")
          .split(";")
          .find((directive) => directive.trim().startsWith("img-src")) ?? "";
      expect(archiveImagePolicy.split(/\s+/)).toContain("https:");
    } finally {
      if (previous === undefined) {
        delete process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL;
      } else {
        process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL = previous;
      }
    }
  });

  it("allows a public-key Sentry DSN as an origin-only connect source", () => {
    const previous = process.env.NEXT_PUBLIC_SENTRY_DSN_WEB;
    process.env.NEXT_PUBLIC_SENTRY_DSN_WEB =
      "https://public-key@o4500000000000000.ingest.us.sentry.io/4500000000000001?secret=discarded";
    try {
      const response = middleware(new NextRequest("https://app.example/login"));
      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy).toContain(
        "connect-src 'self' https://o4500000000000000.ingest.us.sentry.io",
      );
      expect(policy).not.toContain("public-key@");
      expect(policy).not.toContain("4500000000000001");
      expect(policy).not.toContain("secret=discarded");
    } finally {
      if (previous === undefined) {
        delete process.env.NEXT_PUBLIC_SENTRY_DSN_WEB;
      } else {
        process.env.NEXT_PUBLIC_SENTRY_DSN_WEB = previous;
      }
    }
  });

  it("allows only the exact configured direct-upload origin and fails closed when absent", () => {
    const previous = process.env.NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN;
    try {
      process.env.NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN =
        "https://tenant-uploads.s3.us-west-2.amazonaws.com/path";
      const configured = middleware(
        new NextRequest("https://app.example/login"),
      );
      const configuredPolicy =
        configured.headers.get("content-security-policy") ?? "";
      const configuredConnect =
        configuredPolicy
          .split(";")
          .find((directive) => directive.trim().startsWith("connect-src")) ??
        "";
      expect(configuredConnect.split(/\s+/)).toContain(
        "https://tenant-uploads.s3.us-west-2.amazonaws.com",
      );
      expect(configuredConnect).not.toContain("*.s3.amazonaws.com");
      expect(configuredConnect).not.toContain("*.s3.us-west-2.amazonaws.com");

      delete process.env.NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN;
      const absent = middleware(new NextRequest("https://app.example/login"));
      const absentPolicy = absent.headers.get("content-security-policy") ?? "";
      const absentConnect =
        absentPolicy
          .split(";")
          .find((directive) => directive.trim().startsWith("connect-src")) ??
        "";
      expect(absentConnect).not.toContain("amazonaws.com");
    } finally {
      if (previous === undefined) {
        delete process.env.NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN;
      } else {
        process.env.NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN = previous;
      }
    }
  });

  it("enforces a fresh nonce policy on authenticated dashboard responses", () => {
    const first = middleware(
      new NextRequest("https://app.example/app", {
        headers: { cookie: "pw_session=authenticated" },
      }),
    );
    const second = middleware(
      new NextRequest("https://app.example/app", {
        headers: { cookie: "pw_session=authenticated" },
      }),
    );
    const firstPolicy = first.headers.get("content-security-policy") ?? "";
    const secondPolicy = second.headers.get("content-security-policy") ?? "";
    const scriptPolicy = firstPolicy
      .split(";")
      .find((directive) => directive.trim().startsWith("script-src"));
    expect(scriptPolicy).toContain("script-src 'self' 'nonce-");
    expect(scriptPolicy).toContain("'strict-dynamic'");
    expect(scriptPolicy).not.toContain("'unsafe-inline'");
    expect(scriptPolicy).not.toContain("'unsafe-eval'");
    expect(firstPolicy).not.toBe(secondPolicy);
    // The report-only copy neutralises the static tightening candidate but
    // must not report: an identical reporting copy sent every violation on a
    // dashboard page to /api/csp-report twice.
    const reportOnly =
      first.headers.get("content-security-policy-report-only") ?? "";
    expect(firstPolicy).toContain("report-uri /api/csp-report");
    expect(reportOnly).not.toMatch(/report-(uri|to)/);
    expect(reportOnly).toBe(
      firstPolicy
        .split(";")
        .map((directive) => directive.trim())
        .filter((directive) => !directive.startsWith("report-uri"))
        .join("; "),
    );

    const login = middleware(new NextRequest("https://app.example/login"));
    const loginScriptPolicy = (
      login.headers.get("content-security-policy") ?? ""
    )
      .split(";")
      .find((directive) => directive.trim().startsWith("script-src"));
    expect(loginScriptPolicy).toContain("'nonce-");
    expect(loginScriptPolicy).not.toContain("'unsafe-inline'");

    const publicDocument = middleware(
      new NextRequest("https://app.example/pricing", {
        headers: { accept: "text/html" },
      }),
    );
    const publicScriptPolicy = (
      publicDocument.headers.get("content-security-policy") ?? ""
    )
      .split(";")
      .find((directive) => directive.trim().startsWith("script-src"));
    expect(publicScriptPolicy).toContain("'nonce-");
    expect(publicScriptPolicy).not.toContain("'unsafe-inline'");
    expect(publicDocument.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );

    const rscPrefetch = middleware(
      new NextRequest("https://app.example/pricing", {
        headers: { accept: "text/x-component", rsc: "1" },
      }),
    );
    expect(rscPrefetch.headers.get("content-security-policy")).toBeNull();
  });

  it("preserves next-intl's locale request override while adding the CSP nonce", () => {
    const response = middleware(
      new NextRequest("https://app.example/es/forms/newsletter", {
        headers: { accept: "text/html" },
      }),
    );
    const overrides = new Set(
      (response.headers.get("x-middleware-override-headers") ?? "")
        .split(",")
        .map((name) => name.trim()),
    );

    expect(overrides).toContain("x-next-intl-locale");
    expect(overrides).toContain("x-nonce");
    expect(
      response.headers.get("x-middleware-request-x-next-intl-locale"),
    ).toBe("es");
    expect(response.headers.get("x-middleware-request-x-nonce")).toMatch(/\S+/);
  });

  it("hash-authorizes the immutable pre-paint root-layout scripts", () => {
    const computed = [DOCUMENT_LOCALE_SCRIPT, THEME_SCRIPT].map(
      (body) =>
        `'sha256-${createHash("sha256").update(body).digest("base64")}'`,
    );
    expect(computed).toEqual([...ROOT_LAYOUT_SCRIPT_HASHES]);

    const response = middleware(new NextRequest("https://app.example/login"));
    const policy = response.headers.get("content-security-policy") ?? "";
    for (const hash of computed) expect(policy).toContain(hash);
  });

  it("keeps the static-header hash allow-list identical to the nonce path's", () => {
    // next.config.mjs cannot import the TS module, so it restates the digests
    // as a literal. Without this assertion, editing a pre-paint script turns
    // the test above red, the author updates root-layout-scripts.ts, and the
    // config copy silently keeps authorizing the previous script body.
    const config = readFileSync(
      new URL("../../next.config.mjs", import.meta.url),
      "utf8",
    );
    const block = /const rootLayoutScriptHashes = \[([\s\S]*?)\];/.exec(config);
    expect(block, "rootLayoutScriptHashes literal not found").not.toBeNull();
    const declared = [...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(declared).toEqual([...ROOT_LAYOUT_SCRIPT_HASHES]);
  });

  it("hardens frame-ancestors on sensitive routes instead of silently no-opping", () => {
    // sensitiveCSP is built with String.replace on a literal directive. A
    // rename or an added source in the baseline makes that replace match
    // nothing, leaving sensitive routes framable by same-origin documents
    // with no build or test failure to signal it.
    const config = readFileSync(
      new URL("../../next.config.mjs", import.meta.url),
      "utf8",
    );
    const occurrences = config.match(/"frame-ancestors 'self'"/g) ?? [];
    // One in enforcedCSP, one in each of the two .replace() search arguments.
    expect(occurrences).toHaveLength(3);

    const app = middleware(
      new NextRequest("https://app.example/app/settings", {
        headers: { cookie: "pw_session=authenticated" },
      }),
    );
    expect(app.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("scrubs credentials, query strings, fragments and unknown fields", () => {
    expect(
      sanitizeCSPReport({
        "csp-report": {
          "document-uri": "https://user:secret@app.example/path?token=x#frag",
          "blocked-uri": "https://evil.example/x?customer=pii",
          "effective-directive": "connect-src",
          sample: "sensitive script contents",
        },
      }),
    ).toEqual([
      {
        document_uri: "https://app.example/path",
        blocked_uri: "https://evil.example/x",
        source_file: undefined,
        effective_directive: "connect-src",
        violated_directive: undefined,
        disposition: undefined,
        status_code: undefined,
      },
    ]);
  });

  it("redacts bearer tokens carried in the path, not just the query string", () => {
    // The preference center is a capability URL: whoever holds the path
    // segment can read and rewrite that subscriber's subscriptions without
    // logging in, so it must never reach the server log.
    const capability = "a".repeat(64);
    const [report] = sanitizeCSPReport({
      "csp-report": {
        "document-uri": `https://app.example/en/preferences/${capability}`,
        "source-file": `/en/preferences/${capability}`,
        "blocked-uri": "https://evil.example/x",
      },
    });
    expect(report?.document_uri).toBe(
      "https://app.example/en/preferences/[redacted]",
    );
    expect(report?.source_file).toBe("/en/preferences/[redacted]");
    expect(JSON.stringify(report)).not.toContain(capability);
    // Non-secret paths keep their shape so reports stay debuggable.
    expect(
      sanitizeCSPReport({
        "csp-report": { "document-uri": "https://app.example/app/campaigns" },
      })[0]?.document_uri,
    ).toBe("https://app.example/app/campaigns");
  });

  it("accepts a bounded report and rejects oversized bodies", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const accepted = await POST(
      new Request("https://app.example/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/csp-report" },
        body: JSON.stringify({
          "csp-report": {
            "document-uri": "https://app.example/app?secret=x",
            "blocked-uri": "https://blocked.example/",
          },
        }),
      }),
    );
    expect(accepted.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(" ")).not.toContain("secret=x");

    const rejected = await POST(
      new Request("https://app.example/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(16 * 1024 + 1),
      }),
    );
    expect(rejected.status).toBe(413);
    warn.mockRestore();
  });

  it("gives the cached long-tail docs a build-scoped nonce policy that names no request host", () => {
    // /docs/api/* and /docs/skills/* render once and are served from cache for
    // a day, so their script nonce has to outlive any one request. Behind the
    // load balancer the request URL carries the container's bind address, so
    // nothing in the policy may be taken from it: staging served
    // `connect-src https://0.0.0.0:3000/docs …`, which blocked /api/docs/nav
    // and every client-side navigation on these pages.
    const requests = [
      // What Next's standalone server hands middleware behind the ALB.
      "https://0.0.0.0:3000/docs/api/get-health",
      "http://localhost:3000/docs/skills/migrate-start",
      "https://app.example/docs/api/list-subscribers",
      "https://app.example/docs/skills/subscribers_list/",
    ];
    const nonces = new Set<string | undefined>();
    for (const url of requests) {
      const response = middleware(
        new NextRequest(url, {
          headers: { accept: "text/html", cookie: "pw_session=signed-in" },
        }),
      );
      const policy = response.headers.get("content-security-policy") ?? "";
      const directives = directivesOf(policy);
      const nonce = nonceOf(policy);
      nonces.add(nonce);

      expect(policy, url).not.toContain(new URL(url).host);
      expect(policy, url).not.toMatch(
        /0\.0\.0\.0|localhost|127\.0\.0\.1|:3000/,
      );
      expect(directives.get("connect-src")?.[0], url).toBe("'self'");

      // The strict script boundary, with the build's nonce in the request's
      // place: no 'unsafe-inline', no 'unsafe-eval'.
      expect(nonce, url).toMatch(/^\S{16,}$/);
      expect(directives.get("script-src"), url).toEqual([
        "'self'",
        `'nonce-${nonce}'`,
        ...ROOT_LAYOUT_SCRIPT_HASHES,
        "'strict-dynamic'",
      ]);

      // The render is handed the same policy, so the nonce Next writes onto
      // its scripts (and the cache keeps) is the one this header names.
      expect(
        response.headers.get("x-middleware-request-content-security-policy"),
        url,
      ).toBe(policy);
      expect(response.headers.get("x-middleware-request-x-nonce"), url).toBe(
        nonce,
      );

      expect(directives.get("form-action"), url).toEqual(["'none'"]);
      expect(directives.get("frame-src"), url).toEqual(["'none'"]);
      expect(directives.get("frame-ancestors"), url).toEqual(["'none'"]);
      expect(response.headers.get("x-frame-options"), url).toBe("DENY");
      // A window these pages open onto /app (or an /app window that opens
      // them) lands in another browsing context group: no DOM access across.
      expect(response.headers.get("cross-origin-opener-policy"), url).toBe(
        "same-origin",
      );
      expect(
        response.headers.get("content-security-policy-report-only") ?? "",
        url,
      ).not.toMatch(/report-(uri|to)/);
    }
    // One nonce for every request and every page: a cached copy rendered for
    // any of them satisfies the header served with any other.
    expect(nonces.size).toBe(1);
    const [docsNonce] = [...nonces];

    // A client-side navigation's RSC request can be the one that renders and
    // caches the page, so it is handed the same nonce.
    const rsc = middleware(
      new NextRequest("https://0.0.0.0:3000/docs/api/get-health?_rsc=1x2y3", {
        headers: { accept: "text/x-component", rsc: "1" },
      }),
    );
    expect(rsc.headers.get("x-middleware-request-x-nonce")).toBe(docsNonce);
    expect(
      nonceOf(
        rsc.headers.get("x-middleware-request-content-security-policy") ?? "",
      ),
    ).toBe(docsNonce);

    // Everything else in /docs keeps a per-request nonce, never the build's.
    const gettingStarted = middleware(
      new NextRequest("https://app.example/docs/getting-started", {
        headers: { accept: "text/html" },
      }),
    );
    const gettingStartedNonce = nonceOf(
      gettingStarted.headers.get("content-security-policy") ?? "",
    );
    expect(gettingStartedNonce).toMatch(/\S+/);
    expect(gettingStartedNonce).not.toBe(docsNonce);
  });

  it("serves the cached docs the nonce the build baked in, not a per-process one", async () => {
    // A bundle without the build's value stays self-consistent for the life of
    // the process, which is enough for the assertions above but would give
    // every container its own nonce — and a page one container cached would
    // fail the header another serves. Production reads the value next.config
    // generates once per build and inlines here. Drive that path, not the
    // fallback this process otherwise takes.
    const config = readFileSync(
      new URL("../../next.config.mjs", import.meta.url),
      "utf8",
    );
    expect(config).toMatch(/randomBytes\(\d+\)\.toString\("base64"\)/);
    expect(config).toContain(
      "env: { POSTWAVE_CACHED_DOCS_SCRIPT_NONCE: cachedDocsScriptNonce }",
    );

    const fromBuild = "dGhpcy1idWlsZHMtb3duLW5vbmNl";
    vi.stubEnv("POSTWAVE_CACHED_DOCS_SCRIPT_NONCE", fromBuild);
    vi.resetModules();
    try {
      const { middleware: rebuilt } = await import("@/middleware");
      const response = rebuilt(
        new NextRequest("https://0.0.0.0:3000/docs/api/get-health", {
          headers: { accept: "text/html" },
        }),
      );
      const policy = response.headers.get("content-security-policy") ?? "";
      expect(nonceOf(policy)).toBe(fromBuild);
      expect(response.headers.get("x-middleware-request-x-nonce")).toBe(
        fromBuild,
      );
      // A dashboard document in the same bundle keeps its per-request nonce.
      const dashboard = rebuilt(
        new NextRequest("https://0.0.0.0:3000/app/campaigns", {
          headers: { accept: "text/html", cookie: "pw_session=signed-in" },
        }),
      );
      expect(
        nonceOf(dashboard.headers.get("content-security-policy") ?? ""),
      ).not.toBe(fromBuild);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("keeps a fresh per-request nonce policy on dashboard documents", () => {
    const docsNonce = nonceOf(
      middleware(
        new NextRequest("https://app.example/docs/api/list-subscribers", {
          headers: { accept: "text/html" },
        }),
      ).headers.get("content-security-policy") ?? "",
    );
    const [first, second] = [0, 1].map(() =>
      middleware(
        new NextRequest("https://0.0.0.0:3000/app/campaigns", {
          headers: { accept: "text/html", cookie: "pw_session=signed-in" },
        }),
      ),
    );
    const nonces = [first, second].map((response) => {
      const policy = response?.headers.get("content-security-policy") ?? "";
      const nonce = nonceOf(policy);
      expect(nonce).toMatch(/^\S+$/);
      expect(directivesOf(policy).get("script-src")).toEqual([
        "'self'",
        `'nonce-${nonce}'`,
        ...ROOT_LAYOUT_SCRIPT_HASHES,
        "'strict-dynamic'",
      ]);
      expect(directivesOf(policy).get("connect-src")?.[0]).toBe("'self'");
      expect(response?.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
      return nonce;
    });
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(nonces).not.toContain(docsNonce);
    // The opener severance only works while the dashboard does not share the
    // docs pages' opener policy value.
    expect(first?.headers.get("cross-origin-opener-policy")).not.toBe(
      "same-origin",
    );
  });

  it("names each telemetry endpoint on the cached docs by its path, never the API origin", () => {
    // Staging posts web vitals to the API host. Allowing that endpoint by its
    // origin would let a script on these pages make credentialed requests to
    // the whole API (the session cookie is scoped to the parent domain and
    // CORS admits the app origin with credentials).
    vi.stubEnv(
      "NEXT_PUBLIC_WEB_VITALS_ENDPOINT",
      "https://api.example/api/internal/web-vitals",
    );
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://app.example/ingest");
    try {
      const response = middleware(
        new NextRequest("https://app.example/docs/api/list-subscribers", {
          headers: { accept: "text/html" },
        }),
      );
      const policy = response.headers.get("content-security-policy") ?? "";
      const connect =
        policy
          .split(";")
          .map((directive) => directive.trim().split(/\s+/))
          .find(([name]) => name === "connect-src")
          ?.slice(1) ?? [];
      expect(connect).toEqual([
        "'self'",
        "https://app.example/ingest/",
        "https://api.example/api/internal/web-vitals",
      ]);
      for (const source of connect.slice(1)) {
        // Every configured source is path-restricted: a bare origin (with or
        // without the trailing slash) would admit every path on that host.
        expect(new URL(source).pathname, source).not.toBe("/");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("caps a chunked report without a Content-Length while reading it", async () => {
    let pulled = 0;
    // 64 x 4 KiB = 256 KiB: sixteen times the limit, yet finite, so a
    // regression that buffers the whole body fails the assertions below
    // instead of exhausting the worker's heap.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(4 * 1024).fill(0x78));
        if (pulled >= 64) controller.close();
      },
    });
    const response = await POST(
      new Request("https://app.example/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/csp-report" },
        body: endless,
        duplex: "half",
      } as RequestInit),
    );

    expect(response.status).toBe(413);
    // Stopped just past the 16 KiB limit instead of buffering the stream.
    expect(pulled).toBeLessThanOrEqual(6);
  });

  it("answers an upload the browser aborted instead of throwing", async () => {
    const aborted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"csp-report":{'));
        controller.error(
          Object.assign(new Error("aborted"), { code: "ECONNRESET" }),
        );
      },
    });
    const response = await POST(
      new Request("https://app.example/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/csp-report" },
        body: aborted,
        duplex: "half",
      } as RequestInit),
    );

    expect(response.status).toBe(400);
  });
});
