// SPDX-License-Identifier: AGPL-3.0-only
import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  // Tests are excluded: class strings that exist only in specs (and JS
  // expressions that merely look like utilities) otherwise become shipped CSS.
  content: ["./src/**/*.{ts,tsx}", "!./src/__tests__/**"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
          emphasis: "hsl(var(--destructive-emphasis))",
          "emphasis-foreground": "hsl(var(--destructive-emphasis-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
          emphasis: "hsl(var(--success-emphasis))",
          subtle: "hsl(var(--success-subtle))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
          subtle: "hsl(var(--warning-subtle))",
          emphasis: "hsl(var(--warning-emphasis))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
          subtle: "hsl(var(--info-subtle))",
        },
        gold: "hsl(var(--gold))",
        mw: {
          paper: "var(--mw-paper)",
          ink: "var(--mw-ink)",
          yellow: "var(--mw-yellow)",
          pink: "var(--mw-pink)",
          "pink-soft": "var(--mw-pink-soft)",
          blue: "var(--mw-blue)",
          red: "var(--mw-red)",
        },
        chart: {
          1: "hsl(var(--chart-1))",
          2: "hsl(var(--chart-2))",
          3: "hsl(var(--chart-3))",
          4: "hsl(var(--chart-4))",
          5: "hsl(var(--chart-5))",
          6: "hsl(var(--chart-6))",
        },
        pw: {
          paper: "#FDFCF8",
          surface: "#F2F0EA",
          ink: "#0F0F0F",
          ink2: "#1A1A1A",
          line: "#E0DDD3",
          ember: {
            50: "#FCE9EC",
            100: "#F8C3C9",
            200: "#F08591",
            300: "#E55262",
            400: "#D2233A",
            500: "#C8102E",
            600: "#9F0C24",
            700: "#7A081B",
            800: "#560613",
            900: "#33040B",
          },
          gold: "#F2B233",
          "muted-on-paper": "#5C5C5C",
          "muted-on-ink": "#B8B8B8",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "calc(var(--radius) + 4px)",
      },
      fontFamily: {
        // Self-hosted brand fonts expose these CSS variables in globals.css;
        // without this mapping Tailwind silently falls back to system-ui.
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: [
          "var(--font-display)",
          "Arial Narrow",
          "Impact",
          "sans-serif",
        ],
        hand: ["var(--font-hand)", "Segoe Print", "Bradley Hand", "cursive"],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      boxShadow: {
        // Warm-tinted, layered elevation so surfaces sit *in* light, not *on* a
        // flat plane. Tints belong to paper (28deg warm), not pure black.
        "pw-xs": "0 1px 2px 0 hsl(28 30% 10% / 0.04)",
        "pw-sm":
          "0 1px 3px hsl(28 30% 10% / 0.05), 0 1px 2px -1px hsl(28 30% 10% / 0.04)",
        "pw-md":
          "0 4px 12px -2px hsl(28 30% 10% / 0.08), 0 2px 6px -2px hsl(28 30% 10% / 0.05)",
        "pw-lg":
          "0 12px 28px -6px hsl(28 30% 10% / 0.12), 0 6px 12px -6px hsl(28 30% 10% / 0.08)",
      },
      transitionTimingFunction: {
        "pw-out": "cubic-bezier(0.16, 1, 0.3, 1)",
        "pw-spring": "cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
      keyframes: {
        "pw-shimmer": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "pw-shimmer": "pw-shimmer 1.6s infinite",
      },
    },
  },
  plugins: [],
};

export default config;
