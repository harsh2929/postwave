import { defineConfig, type Plugin } from "vite";

import baseConfig from "./vite.config";

/**
 * Source-renderer evidence only.
 *
 * The shared worktree currently has a template wizard importing three
 * constants that its owner has not exported yet. The canonical optimized
 * build correctly fails on that drift. This isolated config supplies those
 * exports in memory so the Commerce route can still be exercised in a live
 * renderer; it must never be used as release-build evidence.
 */
const unblockUnrelatedTemplateDraft: Plugin = {
  name: "commerce-evidence-unblock-unrelated-template-draft",
  enforce: "pre",
  transform(code, id) {
    if (!id.endsWith("/src/components/templates/template-ai.ts")) return null;
    if (code.includes("REVIEWED_TEMPLATE_NAME_MAX_BYTES")) return null;
    return `${code}
export const REVIEWED_TEMPLATE_NAME_MAX_BYTES = 160;
export const REVIEWED_TEMPLATE_PREVIEW_MAX_RUNES = 320;
export const REVIEWED_TEMPLATE_SUBJECT_MAX_RUNES = 320;
`;
  },
};

export default defineConfig({
  ...baseConfig,
  plugins: [unblockUnrelatedTemplateDraft, ...(baseConfig.plugins ?? [])],
  server: {
    ...baseConfig.server,
    host: "127.0.0.1",
    port: 1422,
    strictPort: true,
  },
});
