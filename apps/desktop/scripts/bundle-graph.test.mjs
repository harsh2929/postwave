import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildChunkGraph,
  collectStaticImportClosure,
  findChunksOwningModule,
  findIneffectiveDynamicImports,
  parseChunkImports,
} from "./bundle-graph.mjs";

describe("emitted desktop bundle graph", () => {
  it("distinguishes local static and dynamic ESM imports", () => {
    const imports = parseChunkImports(
      'import "./shared.js"; import value from "pkg"; import("./lazy.js"); import("./styles.css");',
      ["entry.js", "shared.js", "lazy.js"],
    );
    assert.deepEqual([...imports.staticImports], ["shared.js"]);
    assert.deepEqual([...imports.dynamicImports], ["lazy.js"]);
  });

  it("collects a recursive static closure without looping on cycles", () => {
    const sources = new Map([
      ["route.js", 'import "./shared-a.js";'],
      ["shared-a.js", 'import "./shared-b.js";'],
      ["shared-b.js", 'import "./shared-a.js";'],
    ]);
    const graph = buildChunkGraph([...sources.keys()], (chunk) =>
      sources.get(chunk),
    );
    assert.deepEqual(
      [...collectStaticImportClosure("route.js", graph)].sort(),
      ["route.js", "shared-a.js", "shared-b.js"],
    );
  });

  it("detects a dynamic target already reachable through static imports", () => {
    const sources = new Map([
      [
        "route.js",
        'import "./shared.js"; const load = () => import("./api.js");',
      ],
      ["shared.js", 'import "./api.js";'],
      ["api.js", "export const ok = true;"],
    ]);
    const graph = buildChunkGraph([...sources.keys()], (chunk) =>
      sources.get(chunk),
    );
    assert.deepEqual(findIneffectiveDynamicImports(graph), [
      { chunk: "route.js", target: "api.js" },
    ]);
  });

  it("finds a deferred runtime by normalized emitted module ownership", () => {
    const metadata = {
      chunks: {
        "entry.js": {
          modules: { "/repo/src/main.tsx": 10 },
        },
        "route-runtime.js": {
          modules: {
            "C:\\repo\\src\\lib\\api-client-route-runtime.ts": 20,
          },
        },
      },
    };
    assert.deepEqual(
      findChunksOwningModule(
        metadata,
        "/src/lib/api-client-route-runtime.ts",
      ),
      ["route-runtime.js"],
    );
  });
});
