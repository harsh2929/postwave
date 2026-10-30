import React from "react";
import type { DocsThemeConfig } from "nextra-theme-docs";

const config: DocsThemeConfig = {
  logo: (
    <span
      style={{
        display: "flex",
        flexDirection: "column",
        fontWeight: 700,
        letterSpacing: "-0.02em",
      }}
    >
      <span>Moosewave Docs Archive</span>
      <span style={{ color: "#b91c1c", fontSize: "0.7rem" }}>
        NON-PRODUCTION — use the canonical web docs
      </span>
    </span>
  ),
  docsRepositoryBase: undefined,
  footer: {
    content: (
      <span>
        Archived reference — not current product, commercial, compliance, or
        release documentation.
      </span>
    ),
  },
  color: {
    hue: 215,
    saturation: 20,
    lightness: 45,
  },
  search: {
    placeholder: "Search docs...",
  },
  darkMode: true,
  nextThemes: {
    defaultTheme: "system",
  },
  editLink: {
    component: null,
  },
  feedback: {
    content: null,
  },
  toc: {
    backToTop: true,
  },
  head: (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="robots" content="noindex,nofollow,noarchive" />
      <meta
        name="description"
        content="Moosewave documentation: migration, deliverability, voice AI, and more."
      />
      <meta property="og:title" content="Moosewave Docs" />
    </>
  ),
};

export default config;
