// SPDX-License-Identifier: AGPL-3.0-only

// A Markdown file imported as its text (webpack asset/source in next.config;
// Vite's built-in ?raw under vitest).
declare module "*.md?raw" {
  const text: string;
  export default text;
}
