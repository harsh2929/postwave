// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const LOCALES = ["es", "fr", "de", "pt", "ja"] as const;
const NAMESPACES = ["preferences", "archive", "gift", "tour"] as const;
const LOCALES_DIR = join(process.cwd(), "locales");

type Messages = Record<string, unknown>;

function load(locale: string): Messages {
  return JSON.parse(
    readFileSync(join(LOCALES_DIR, `${locale}.json`), "utf8"),
  ) as Messages;
}

function flatten(
  value: unknown,
  prefix = "",
  result: Record<string, string> = {},
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) result[prefix] = String(value);
    return result;
  }

  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, result);
  }
  return result;
}

function selected(messages: Messages): Record<string, string> {
  const result: Record<string, string> = {};
  for (const namespace of NAMESPACES) {
    flatten(messages[namespace], namespace, result);
  }
  return result;
}

function icuContract(message: string): {
  arguments: string[];
  pluralSelectors: string[];
  poundSigns: number;
} {
  return {
    arguments: [...message.matchAll(/\{\s*([A-Za-z_][\w]*)(?=\s*[,}])/g)]
      .map((match) => match[1])
      .sort(),
    pluralSelectors: [
      ...message.matchAll(
        /(?:^|[\s,])((?:=\d+|zero|one|two|few|many|other))\s*\{/g,
      ),
    ]
      .map((match) => match[1])
      .sort(),
    poundSigns: message.match(/#/g)?.length ?? 0,
  };
}

describe("localized public message bundles", () => {
  const english = selected(load("en"));
  const englishKeys = Object.keys(english).sort();

  it.each(LOCALES)(
    "%s preserves key and ICU contracts for preferences, archive, gift, and tour",
    (locale) => {
      const translated = selected(load(locale));
      expect(Object.keys(translated).sort()).toEqual(englishKeys);

      for (const key of englishKeys) {
        expect(icuContract(translated[key]), `${locale}:${key}`).toEqual(
          icuContract(english[key]),
        );
      }
    },
  );

  it.each(LOCALES)(
    "%s does not silently ship the English fallback in those namespaces",
    (locale) => {
      const translated = selected(load(locale));
      const unchanged = englishKeys.filter(
        (key) => translated[key] === english[key],
      );

      expect(unchanged, `${locale} contains verbatim English values`).toEqual(
        [],
      );
    },
  );
});
