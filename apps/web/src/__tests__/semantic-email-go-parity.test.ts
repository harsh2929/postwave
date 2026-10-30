// SPDX-License-Identifier: AGPL-3.0-only
//
// Differential test: the TypeScript semantic-email mirror against the REAL Go
// implementation.
//
// The fixture is not hand-written. `pnpm semantic-fixtures:regen` copies
// scripts/semantic-projection-fixtures.go.txt into
// apps/api/internal/semanticemail, runs the corpus through
// NormalizeAndValidateV2 and CompileV2, records the normalized documents, the
// diagnostics, the HTML and the plain text, and deletes the temporary file
// again. Everything asserted below therefore came out of the compiler that
// actually renders the email.
//
// This is the answer to "a preview that can drift". It can still drift — it is
// a second implementation — but it cannot drift QUIETLY: change the Go
// renderer, regenerate, and these assertions fail with the exact bytes that
// moved.

import { describe, expect, it } from "vitest";

import fixtureFile from "./fixtures/semantic-email-projection.json";
import { compileDocument } from "@/lib/semantic-email/project";
import { normalizeDocument } from "@/lib/semantic-email/normalize";
import { wireDocument } from "@/lib/semantic-email/wire";
import {
  normalizationDiagnostics,
  validateNormalizedDocument,
} from "@/lib/semantic-email/validate";
import { decodeSemanticNodes } from "@/lib/semantic-email/decode";
import type {
  Diagnostic,
  SemanticDocument,
  SemanticNode,
} from "@/lib/semantic-email/types";

interface FixtureCase {
  name: string;
  note: string;
  locale: string;
  slots: Record<string, string> | null;
  input: unknown;
  normalized: unknown;
  validate_diagnostics: Diagnostic[];
  compile_diagnostics: Diagnostic[];
  compile_failed: boolean;
  html: string;
  text: string;
}

const fixture = fixtureFile as unknown as {
  generator: string;
  compiler_version: string;
  html_version: string;
  text_version: string;
  cases: FixtureCase[];
};

/**
 * Go marshals a nil slice as null and an empty slice as []. Both have length
 * zero everywhere the model reads them, and the TypeScript model holds exactly
 * one representation of "no entries", so the comparison folds null into the
 * empty container — and ONLY for the five container fields, so a genuinely
 * different array or a null anywhere else still fails.
 */
const CONTAINER_ARRAY_KEYS = new Set([
  "nodes",
  "runs",
  "items",
  "options",
  "conditions",
]);

function canonical(value: unknown, key = ""): unknown {
  if (value === null || value === undefined) {
    if (CONTAINER_ARRAY_KEYS.has(key)) return [];
    if (key === "localizations") return {};
    return null;
  }
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, ""));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const entry of Object.keys(source).sort()) {
      out[entry] = canonical(source[entry], entry);
    }
    return out;
  }
  return value;
}

function documentFromFixture(input: unknown): SemanticDocument {
  const source = input as Record<string, unknown>;
  const decoded = decodeSemanticNodes(source.nodes ?? []);
  if (decoded.nodes === null) {
    throw new Error(
      `fixture nodes did not decode: ${JSON.stringify(decoded.diagnostics)}`,
    );
  }
  return {
    schema_version: Number(source.schema_version ?? 0),
    language: String(source.language ?? ""),
    direction: String(source.direction ?? ""),
    nodes: decoded.nodes as SemanticNode[],
  };
}

describe("semantic-email TypeScript mirror vs the Go compiler", () => {
  it("was generated from the pinned compiler versions", () => {
    expect(fixture.generator).toBe(
      "apps/web/scripts/semantic-projection-fixtures.go.txt",
    );
    expect(fixture.compiler_version).toBe("postwave.semantic-email.compiler.v2");
    expect(fixture.html_version).toBe("postwave.semantic-email.html.v2");
    expect(fixture.text_version).toBe("postwave.semantic-email.text.v2");
    expect(fixture.cases.length).toBeGreaterThan(25);
  });

  for (const testCase of fixture.cases) {
    describe(testCase.name, () => {
      const document = documentFromFixture(testCase.input);

      it("normalizes to the same document Go stores", () => {
        expect(canonical(wireDocument(normalizeDocument(document)))).toEqual(
          canonical(testCase.normalized),
        );
      });

      it("reports the same authoring diagnostics, in the same order", () => {
        const diagnostics = [
          ...normalizationDiagnostics(document),
          ...validateNormalizedDocument(normalizeDocument(document)),
        ];
        expect(diagnostics).toEqual(testCase.validate_diagnostics);
      });

      it("reports the same compile diagnostics", () => {
        const result = compileDocument(document, {
          locale: testCase.locale,
          slots: testCase.slots ?? {},
        });
        expect(result.diagnostics).toEqual(testCase.compile_diagnostics);
        expect(result.ok).toBe(!testCase.compile_failed);
      });

      it("projects the same HTML and plain text", () => {
        const result = compileDocument(document, {
          locale: testCase.locale,
          slots: testCase.slots ?? {},
        });
        expect(result.html).toBe(testCase.html);
        expect(result.text).toBe(testCase.text);
      });
    });
  }
});
