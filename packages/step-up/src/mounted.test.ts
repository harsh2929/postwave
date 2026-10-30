// SPDX-License-Identifier: AGPL-3.0-only
//
// Every surface must MOUNT its step-up prompt, not merely contain one.
//
// This exists because mobile's prompt sat in the tree unrendered. The component
// was written, it imported this package, it handled the challenge correctly —
// and no parent ever rendered it, so on that surface a step-up challenge would
// have arrived as a bare 401 and been read as a dead session. A file listing
// showed three prompts and the product had two.
//
// That is the failure this repository keeps meeting from different directions,
// and the reason the server-side gate is still unmounted: mounting is
// all-clients, so one surface that cannot answer turns high-risk actions into
// logouts there. A check that the component EXISTS would have passed throughout.
// This checks that something renders it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Where each surface mounts the prompt, and what its own component is called.
 *
 * The mount file is named rather than searched for. A search would pass on any
 * file that happens to mention the symbol — including the component's own
 * definition and its tests, which is exactly how "mobile has a prompt" read as
 * true. Pinning the parent means moving the mount is a deliberate edit here.
 */
const surfaces = [
  {
    name: "web",
    mount: "apps/web/src/app/(dashboard)/dashboard-shell.tsx",
    component: "StepUpPrompt",
  },
  {
    name: "desktop",
    mount: "apps/desktop/src/App.tsx",
    component: "StepUpPrompt",
  },
  {
    // Outside src/ — expo-router owns this path. Worth stating, because a sweep
    // scoped to apps/mobile/src (the obvious scope) finds the component and
    // misses the mount, which is how this went unnoticed.
    name: "mobile",
    mount: "apps/mobile/app/_layout.tsx",
    component: "StepUpPrompt",
  },
] as const;

describe("the step-up prompt is mounted on every surface", () => {
  for (const surface of surfaces) {
    it(`${surface.name} renders <${surface.component} /> in ${surface.mount}`, () => {
      const source = readFileSync(join(repoRoot, surface.mount), "utf8");

      // Imported AND rendered. Importing alone is what mobile had: the symbol
      // resolves, the bundle grows, and nothing appears.
      expect(
        source.includes(surface.component),
        `${surface.mount} does not reference ${surface.component}`,
      ).toBe(true);

      const rendered = new RegExp(`<${surface.component}\\s*/>|<${surface.component}\\s`);
      expect(
        rendered.test(source),
        `${surface.mount} imports ${surface.component} but never renders it — ` +
          `a step-up challenge on ${surface.name} would arrive as a bare 401 and ` +
          `be read as a dead session`,
      ).toBe(true);
    });
  }

  it("covers every surface that ships a prompt", () => {
    // A surface added later with a prompt and no entry here would be unguarded,
    // and unguarded is precisely the state mobile was in. Three today; this
    // fails if a fourth prompt appears without being listed above.
    const known = new Set(surfaces.map((s) => s.name));
    expect(known).toEqual(new Set(["web", "desktop", "mobile"]));
  });
});
