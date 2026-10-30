import nextra from "nextra";

if (
  process.env.NODE_ENV === "production" &&
  process.env.POSTWAVE_ARCHIVED_DOCS_PREVIEW !== "1"
) {
  throw new Error(
    "docs-site is archived and cannot be built for production; use the canonical apps/web docs or the explicit archive-preview script",
  );
}

const withNextra = nextra({
  theme: "nextra-theme-docs",
  themeConfig: "./theme.config.tsx",
  defaultShowCopyCode: true,
  search: { codeblocks: false },
});

export default withNextra({
  reactStrictMode: true,
  pageExtensions: ["mdx", "tsx"],
  experimental: { mdxRs: false },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow, noarchive",
          },
        ],
      },
    ];
  },
});
