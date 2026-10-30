// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import GettingStartedPage from "@/app/(docs)/docs/getting-started/page";
import { DOCS_MIGRATION_SOURCES } from "@/lib/docs/catalog";
import { listOperations, operationsByTag } from "@/lib/docs/loadOpenAPI";
import { getSearchIndex } from "@/lib/docs/search.server";

const WEB_ROOT = resolve(process.cwd());

function source(path: string): string {
  return readFileSync(resolve(WEB_ROOT, path), "utf8");
}

describe("docs developer portal integrity", () => {
  it("derives the getting-started and search counts from the live spec", () => {
    const operations = listOperations().length;
    const tags = operationsByTag().length;
    const html = renderToStaticMarkup(<GettingStartedPage />);

    expect(html).toContain(`${operations} REST endpoints across ${tags} tags`);
    expect(html).toContain(
      `all ${DOCS_MIGRATION_SOURCES.length} supported migration sources`,
    );

    const searchDoc = getSearchIndex().docs.find(
      (doc) => doc.url === "/docs/api",
    );
    expect(searchDoc?.body).toContain(
      `${operations} endpoints across ${tags} tags`,
    );
  });

  it("includes Sendy in the shared migration navigation catalog", () => {
    expect(DOCS_MIGRATION_SOURCES).toContainEqual({
      slug: "sendy",
      name: "Sendy",
    });
  });

  it("keeps the search corpus server-side and serializes nav data once", () => {
    const layout = source("src/app/(docs)/layout.tsx");
    expect(layout).not.toContain("getSearchIndex");
    expect(layout).toContain("<SearchBar />");
    expect(layout.match(/<DocsNavProvider value=/g)).toHaveLength(1);
    expect(layout).not.toContain("apiGroups={apiGroups}");
    expect(layout).not.toContain("skillGroups={skillGroups}");
  });

  it("does not advertise GitHub mirrors that have not been published", () => {
    const surfaces = [
      "src/app/(docs)/docs/api/page.tsx",
      "src/components/docs/OpenAPIEndpoint.tsx",
      "src/app/(marketing)/api-docs/page.tsx",
      "src/app/(marketing)/api-docs/_components/api-reference-preview.tsx",
      "src/app/(marketing)/mcp/page.tsx",
    ].map(source);
    const combined = surfaces.join("\n");

    expect(combined).not.toContain("github.com/postwave/openapi");
    expect(combined).not.toContain("github.com/postwave/mcp-server");
    expect(combined).toContain("/api/openapi.json");
  });

  it("removes the unused CopyableCode client component", () => {
    expect(
      existsSync(resolve(WEB_ROOT, "src/components/docs/CopyableCode.tsx")),
    ).toBe(false);
  });
});
