import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Minimal ambient declaration so we can reach into process.env without pulling
// in @types/node as a devDependency. Tauri sets TAURI_DEV_HOST when running
// `tauri dev` against a remote/mobile target.
declare const process: { env: Record<string, string | undefined> };

const generateReleaseSourceMaps =
  process.env.POSTWAVE_GENERATE_SOURCEMAPS === "1";

function emittedBundleMetadata(): Plugin {
  return {
    name: "postwave-emitted-bundle-metadata",
    generateBundle(_options, bundle) {
      const chunks: Record<
        string,
        {
          imports: string[];
          dynamicImports: string[];
          css: string[];
          modules: Record<string, number>;
        }
      > = {};
      const fileName = (path: string): string =>
        path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const viteChunk = output as typeof output & {
          viteMetadata?: { importedCss?: Set<string> };
        };
        chunks[fileName(output.fileName)] = {
          imports: output.imports.map(fileName).sort(),
          dynamicImports: output.dynamicImports.map(fileName).sort(),
          css: [...(viteChunk.viteMetadata?.importedCss ?? [])]
            .map(fileName)
            .sort(),
          // Source-level ownership makes a preload regression actionable:
          // reviewers can identify which runtime modules made a chunk grow
          // without relying on a local visualizer or source maps.
          modules: Object.fromEntries(
            Object.entries(output.modules)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([moduleId, rendered]): [string, number] => [
                moduleId.replaceAll("\\", "/"),
                rendered.renderedLength,
              ]),
          ),
        };
      }
      this.emitFile({
        type: "asset",
        fileName: "postwave-bundle-metadata.json",
        source: `${JSON.stringify({ schemaVersion: 1, chunks })}\n`,
      });
    },
  };
}

// Vite config for the Tauri-hosted frontend shell.
//
// Notes:
//   - The Tauri shell at ../src-tauri/ expects `frontendDist: "../dist"`,
//     so we emit the production bundle to ../dist relative to this file.
//   - `clearScreen: false` keeps Tauri's logs visible when Vite reloads.
//   - Port 1420 matches `devUrl` in tauri.conf.json.
//   - `envPrefix` exposes both VITE_* and TAURI_* env vars to the client.
export default defineConfig({
  plugins: [react(), emittedBundleMetadata()],

  // The Tauri shell at `apps/desktop/src-tauri/` references the bundle as
  // `frontendDist: "../dist"`, which (relative to that folder) resolves to
  // `apps/desktop/dist/` — i.e. just `dist` from this Vite project root.
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Keep the bootstrap parse-compatible with the oldest installable OS
    // runtimes so it can render the fail-closed update screen. The application
    // feature floor is WebKit 16.2 / WebView2 111 and is enforced before
    // credential hydration in runtime-compatibility.ts.
    target: ["safari14", "chrome109"],
    // Maps are sensitive release intermediates: Tauri embeds this entire
    // directory. Release CI opts in only for the pre-package Sentry upload,
    // then deletes and verifies them before native bundling. Normal/local
    // builds cannot accidentally package application source.
    sourcemap: generateReleaseSourceMaps ? "hidden" : false,
    rollupOptions: {
      // A dynamic import that is also reachable through a static import does
      // not defer download or parsing. Treat that warning as a build failure
      // so route-splitting comments cannot silently diverge from the emitted
      // graph again. Other warnings retain Vite's normal reporting behavior.
      onLog(level, log, defaultHandler) {
        if (level === "warn" && log.code === "INEFFECTIVE_DYNAMIC_IMPORT") {
          throw new Error(
            `[desktop-build] ineffective dynamic import: ${log.message}`,
          );
        }
        defaultHandler(level, log);
      },
      output: {
        // Section pages each become their own chunk via React.lazy() in
        // App.tsx. Isolate only the eager facade itself. A prefix match here
        // previously swallowed `api-client-route-runtime.ts` too, collapsing
        // its real dynamic boundary back into the critical preload.
        manualChunks(id: string): string | undefined {
          const normalizedId = id.replaceAll("\\", "/");
          if (normalizedId.endsWith("/src/lib/api-client.ts")) {
            return "api-client";
          }
          return undefined;
        },
      },
    },
  },

  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
  },

  envPrefix: ["VITE_", "TAURI_"],
});
