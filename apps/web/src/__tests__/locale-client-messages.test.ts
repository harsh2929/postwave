// SPDX-License-Identifier: AGPL-3.0-only
//
// The public /[locale] layout narrows the message bundle it hands to
// NextIntlClientProvider (see src/i18n/client-messages.ts). That is only safe
// while the list covers every namespace a CLIENT component under that segment
// reads — a missing one renders as a raw key on a subscriber-facing page.
// This derives the required set from the consumers, not from the list.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  clientMessageNamespaces,
  pickClientMessages,
} from "@/i18n/client-messages";

const appDir = path.resolve(__dirname, "../..");
const localeSegment = path.join(appDir, "src/app/[locale]");
const localesDir = path.join(appDir, "locales");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Client components pulled in from @/components by the locale segment. */
function referencedComponents(files: string[]): string[] {
  const referenced = new Set<string>();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/from "@\/components\/([^"]+)"/g)) {
      const specifier = match[1];
      if (!specifier) continue;
      for (const extension of [".tsx", ".ts"]) {
        const candidate = path.join(appDir, "src/components", specifier + extension);
        if (fs.existsSync(candidate)) referenced.add(candidate);
      }
    }
  }
  return [...referenced];
}

function namespacesRead(files: string[]): Set<string> {
  const namespaces = new Set<string>();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    if (!source.includes('"use client"')) continue;
    for (const match of source.matchAll(/useTranslations\(\s*"([^"]+)"/g)) {
      const root = match[1]?.split(".")[0];
      if (root) namespaces.add(root);
    }
  }
  return namespaces;
}

describe("public locale-segment client messages", () => {
  const files = sourceFiles(localeSegment);

  it("covers every namespace a client component under /[locale] reads", () => {
    const required = namespacesRead([...files, ...referencedComponents(files)]);
    expect(required.size).toBeGreaterThan(0);
    const uncovered = [...required]
      .filter((ns) => !(clientMessageNamespaces as readonly string[]).includes(ns))
      .sort();
    expect(uncovered).toEqual([]);
  });

  it("only names namespaces that exist in every shipped locale", () => {
    for (const file of fs.readdirSync(localesDir)) {
      if (!file.endsWith(".json")) continue;
      const bundle = JSON.parse(
        fs.readFileSync(path.join(localesDir, file), "utf8"),
      ) as Record<string, unknown>;
      for (const namespace of clientMessageNamespaces) {
        expect(
          Object.hasOwn(bundle, namespace),
          `${file} is missing the ${namespace} namespace`,
        ).toBe(true);
      }
    }
  });

  it("drops the server-only namespaces from what the browser receives", () => {
    const bundle = JSON.parse(
      fs.readFileSync(path.join(localesDir, "en.json"), "utf8"),
    ) as Record<string, unknown>;
    const picked = pickClientMessages(bundle);
    expect(Object.keys(picked).sort()).toEqual(
      [...clientMessageNamespaces].sort(),
    );
    // Namespaces only ever read through getTranslations() must not be
    // serialized into the flight payload.
    for (const serverOnly of ["archive", "gift", "tour", "paywall"]) {
      expect(Object.hasOwn(bundle, serverOnly)).toBe(true);
      expect(Object.hasOwn(picked, serverOnly)).toBe(false);
    }
    expect(JSON.stringify(picked).length).toBeLessThan(
      JSON.stringify(bundle).length / 2,
    );
  });
});
