/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        // Moosewave BRAND tokens, kept 1:1 with apps/web + apps/desktop:
        // ember accent on an ink/paper canvas with warm borders. These
        // encode the DARK palette (the runtime useTheme() flips light);
        // see src/lib/theme.ts for the full light+dark token sets.
        bg: {
          DEFAULT: "#0f0f0f",
          subtle: "#161616",
          card: "#1a1a1a",
          elevated: "#242424",
        },
        fg: {
          DEFAULT: "#f6f4ed",
          muted: "#b8b8b8",
          subtle: "#8a8a86",
        },
        border: {
          DEFAULT: "#2e2e2e",
          subtle: "#242424",
        },
        accent: {
          DEFAULT: "#e55262",
          dim: "#c8102e",
          subtle: "#3a1a20",
        },
        danger: "#f0623d",
        warn: "#f1c04c",
        success: "#34d399",
        info: "#7aa2f0",
        gold: "#f1c04c",
      },
      fontFamily: {
        // Body = Inter (loaded via expo-font in _layout); display = Fraunces
        // editorial serif for headlines / big metrics — brand parity with web.
        sans: ["Inter", "System"],
        display: ["Fraunces", "Georgia", "serif"],
        mono: ["JetBrainsMono", "Menlo"],
      },
    },
  },
  plugins: [],
};
