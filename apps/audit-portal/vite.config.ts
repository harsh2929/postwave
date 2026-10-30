import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for the embeddable audit-portal SPA.
//
// Notes:
//   - base "/portal/audit/" mirrors the credential-free API gateway route;
//     the one-time bootstrap exists only in the URL fragment.
//   - emits to ../../apps/audit-portal/dist so the Go binary can
//     pick it up via POSTWAVE_PORTAL_SPA_DIR.
//   - port 1421 is offset by one from the desktop dev server (1420)
//     so both can run side-by-side during portal UX work.
export default defineConfig({
  plugins: [react()],
  base: "/portal/audit/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: ["safari14", "chrome109"],
    // Customer-facing portal bundles never ship source maps. A hidden map is
    // still downloadable when its hashed filename is guessed or disclosed by
    // an artifact index, so omission is the production-safe default.
    sourcemap: false,
  },
  server: {
    port: 1421,
    strictPort: false,
  },
});
