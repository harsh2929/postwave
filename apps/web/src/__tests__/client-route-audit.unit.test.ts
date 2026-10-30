// SPDX-License-Identifier: AGPL-3.0-only
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  auditApiClientCalls,
  compileGatewayRouteMatcher,
} from "./helpers/client-route-audit";

const VIRTUAL_ROOT = resolve("/virtual/postwave-web/src");
const VIRTUAL_FILE = resolve(VIRTUAL_ROOT, "client.ts");
const ROUTE_AUDIT_TIMEOUT_MS = 15_000;

function fixtureProgram(source: string): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    // These fixtures exercise our pathname evaluator, not TypeScript's
    // standard-library declarations. Avoid loading/parsing the full lib graph
    // for every tiny virtual program; under a full shard that unrelated work
    // could consume the runner's entire five-second test budget.
    noLib: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) =>
    fileName === VIRTUAL_FILE || ts.sys.fileExists(fileName);
  host.readFile = (fileName) =>
    fileName === VIRTUAL_FILE ? source : ts.sys.readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    fileName === VIRTUAL_FILE
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : getSourceFile(fileName, languageVersion, onError, shouldCreate);
  return ts.createProgram([VIRTUAL_FILE], options, host);
}

function audit(source: string) {
  return auditApiClientCalls(fixtureProgram(source), VIRTUAL_ROOT);
}

/** A client file plus one library module at `lib/<name>.ts`. */
function auditWithLib(libName: string, libSource: string, source: string) {
  const libFile = resolve(VIRTUAL_ROOT, "lib", `${libName}.ts`);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };
  const files = new Map([
    [VIRTUAL_FILE, source],
    [libFile, libSource],
  ]);
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) =>
    files.has(fileName) || ts.sys.fileExists(fileName);
  host.readFile = (fileName) =>
    files.get(fileName) ?? ts.sys.readFile(fileName);
  host.directoryExists = (directory) =>
    directory.startsWith(VIRTUAL_ROOT) ||
    (ts.sys.directoryExists?.(directory) ?? false);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = files.get(fileName);
    return text === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  return auditApiClientCalls(
    ts.createProgram([VIRTUAL_FILE, libFile], options, host),
    VIRTUAL_ROOT,
  );
}

const NOTE_KEY_LIB = `
export function noteAttachmentKeyPath(fileKey: string): string {
  return fileKey.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
`;

const prelude = `
declare const api: {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  postRaw<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  putRaw<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
};
`;

describe("TypeScript API pathname evaluator", () => {
  it(
    "collects literal and no-substitution template calls",
    () => {
      const result = audit(`${prelude}
      api.get("/api/v1/literal");
      api.postRaw(\`/api/v1/template\`);
    `);
      expect(result.unresolved).toEqual([]);
      expect(
        result.calls.map((call) => `${call.method} ${call.paths[0]?.value}`),
      ).toEqual(["GET /api/v1/literal", "POST /api/v1/template"]);
    },
    ROUTE_AUDIT_TIMEOUT_MS,
  );

  it(
    "expands finite string unions and encoded template segments",
    () => {
      const result = audit(`${prelude}
      function load(kind: "drafts" | "sent", id: string) {
        return api.get(\`/api/v1/\${kind}/\${encodeURIComponent(id)}\`);
      }
    `);
      expect(result.unresolved).toEqual([]);
      expect(result.unsafeDynamicSegments).toEqual([]);
      expect(
        result.calls[0]?.paths.map((path) =>
          path.value.replace(/__POSTWAVE_DYNAMIC_\d+__/u, "{encoded}"),
        ),
      ).toEqual(["/api/v1/drafts/{encoded}", "/api/v1/sent/{encoded}"]);
    },
    ROUTE_AUDIT_TIMEOUT_MS,
  );

  it(
    "evaluates helper returns and aliases to encodeURIComponent",
    () => {
      const result = audit(`${prelude}
      const enc = encodeURIComponent;
      const ROOT = "/api/v1/things" as const;
      function detailPath(id: string): string {
        return \`\${ROOT}/\${enc(id)}?include=summary\`;
      }
      function load(id: string) { return api.get(detailPath(id)); }
    `);
      expect(result.unresolved).toEqual([]);
      expect(result.unsafeDynamicSegments).toEqual([]);
      expect(result.calls[0]?.paths[0]?.value).toMatch(
        /^\/api\/v1\/things\/__POSTWAVE_DYNAMIC_\d+__$/u,
      );
    },
    ROUTE_AUDIT_TIMEOUT_MS,
  );

  it(
    "strips query expressions before demanding their resolution",
    () => {
      const result = audit(`${prelude}
      declare function opaqueQuery(): string;
      api.get(\`/api/v1/things?query=\${opaqueQuery()}\`);
    `);
      expect(result.unresolved).toEqual([]);
      expect(result.unsafeDynamicSegments).toEqual([]);
      expect(result.calls[0]?.paths.map((path) => path.value)).toEqual([
        "/api/v1/things",
      ]);
    },
    ROUTE_AUDIT_TIMEOUT_MS,
  );

  it(
    "fails closed on an unresolved whole-path expression",
    () => {
      const result = audit(`${prelude}
      declare function opaquePath(): string;
      api.get(opaquePath());
    `);
      expect(result.calls).toEqual([]);
      expect(result.unresolved).toHaveLength(1);
      expect(result.unresolved[0]?.reason).toContain(
        "not statically bounded to /api",
      );
    },
    ROUTE_AUDIT_TIMEOUT_MS,
  );

  it(
    "reports raw string pathname segments independently of reachability",
    () => {
      const result = audit(`${prelude}
      function load(id: string) { return api.get(\`/api/v1/things/\${id}\`); }
    `);
      expect(result.unresolved).toEqual([]);
      expect(result.calls).toHaveLength(1);
      expect(result.unsafeDynamicSegments).toHaveLength(1);
      expect(result.unsafeDynamicSegments[0]?.expression).toBe("id");
    },
    ROUTE_AUDIT_TIMEOUT_MS,
  );

  it(
    "accepts the reviewed note-attachment key helper as one multi-segment tail",
    () => {
      const result = auditWithLib(
        "subscriber-profile-api",
        NOTE_KEY_LIB,
        `${prelude}
      import { noteAttachmentKeyPath } from "./lib/subscriber-profile-api";
      function remove(id: string, note: string, key: string) {
        return api.delete(\`/api/v1/subscribers/\${encodeURIComponent(id)}/notes/\${encodeURIComponent(note)}/attachments/\${noteAttachmentKeyPath(key)}\`);
      }
    `,
      );
      expect(result.unresolved).toEqual([]);
      expect(result.unsafeDynamicSegments).toEqual([]);
      expect(result.calls[0]?.paths[0]?.value).toMatch(
        /\/attachments\/__POSTWAVE_DYNAMIC_TAIL_\d+__$/u,
      );
    },
    ROUTE_AUDIT_TIMEOUT_MS,
  );

  it(
    "does not trust a same-named helper declared outside the reviewed module",
    () => {
      const result = auditWithLib(
        "somewhere-else",
        NOTE_KEY_LIB,
        `${prelude}
      import { noteAttachmentKeyPath } from "./lib/somewhere-else";
      function remove(key: string) {
        return api.delete(\`/api/v1/files/\${noteAttachmentKeyPath(key)}\`);
      }
    `,
      );
      expect(
        result.calls
          .flatMap((call) => call.paths)
          .some((path) => path.value.includes("__POSTWAVE_DYNAMIC_TAIL_")),
      ).toBe(false);
      expect(
        result.unresolved.length + result.unsafeDynamicSegments.length,
      ).toBeGreaterThan(0);
    },
    ROUTE_AUDIT_TIMEOUT_MS,
  );
});

describe("authoritative gateway structural matcher", () => {
  it("supports parameters, method-agnostic wildcards, and query stripping", () => {
    const matcher = compileGatewayRouteMatcher([
      "GET /api/v1/items/{id}",
      "ANY /api/v1/dmarc/{rest}",
    ]);
    expect(
      matcher.match("GET", {
        value: "/api/v1/items/123?view=full",
        bindableSegments: [3],
      }),
    ).toMatchObject({ mounted: true, route: "GET /api/v1/items/{id}" });
    expect(matcher.match("DELETE", "/api/v1/dmarc/reports/123")).toMatchObject({
      mounted: true,
      route: "ANY /api/v1/dmarc/{rest}",
    });
  });

  it("does not let an unproven literal subroute bind a path parameter", () => {
    const matcher = compileGatewayRouteMatcher(["GET /api/v1/base/{id}"]);
    expect(
      matcher.match("GET", "/api/v1/base/not-a-real-subroute").mounted,
    ).toBe(false);
    expect(
      matcher.match("GET", {
        value: "/api/v1/base/reviewed-choice",
        bindableSegments: [3],
      }).mounted,
    ).toBe(true);
  });

  it("binds a multi-segment tail only to a reviewed route's final parameter", () => {
    const tail = "__POSTWAVE_DYNAMIC_TAIL_0__";
    const id = "__POSTWAVE_DYNAMIC_1__";
    const reviewed =
      "DELETE /api/v1/subscribers/{id}/notes/{note}/attachments/{file_key}";
    const matcher = compileGatewayRouteMatcher([
      reviewed,
      "DELETE /api/v1/files/{key}",
      "GET /api/v1/files/{key}/meta",
    ]);
    expect(
      matcher.match(
        "DELETE",
        `/api/v1/subscribers/${id}/notes/${id}/attachments/${tail}`,
      ),
    ).toMatchObject({ mounted: true, route: reviewed });
    // Same shape, but the server registers {key} as one segment.
    expect(matcher.match("DELETE", `/api/v1/files/${tail}`).mounted).toBe(
      false,
    );
    // Never a non-final parameter, and never glued to literal text.
    expect(matcher.match("GET", `/api/v1/files/${tail}/meta`).mounted).toBe(
      false,
    );
    expect(
      matcher.match(
        "DELETE",
        `/api/v1/subscribers/${id}/notes/${id}/attachments/x-${tail}`,
      ).mounted,
    ).toBe(false);
  });

  it("gives an exact literal route precedence over a parameter route", () => {
    const matcher = compileGatewayRouteMatcher([
      "GET /api/v1/campaigns/{id}",
      "POST /api/v1/campaigns/test-send",
    ]);
    expect(matcher.match("GET", "/api/v1/campaigns/test-send").mounted).toBe(
      false,
    );
    expect(matcher.match("POST", "/api/v1/campaigns/test-send").mounted).toBe(
      true,
    );
  });
});
