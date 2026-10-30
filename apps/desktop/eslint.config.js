import tseslint from "typescript-eslint";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

/*
 * Incremental ESLint baseline focused on rules that prevent theme,
 * accessibility, async, Unicode, and type-aware correctness regressions.
 * Rules are enabled only after the current tree is clean so the zero-warning
 * contract remains useful; the broader TypeScript bundles are still being
 * adopted in reviewed batches.
 */

const HEX_COLOR_PATTERN = "/^#[0-9a-fA-F]{3,8}$/";
// Match strings that contain a raw rgb/rgba/hsl/hsla function call —
// boxShadow: "0 4px rgba(0,0,0,0.4)" and similar. We want these to come
// from --pw-* tokens or color-mix() instead.
const RAW_COLOR_FN_PATTERN = "/rgba?\\(|hsla?\\(/";
// Match strings that reference a CSS custom-property that is NOT prefixed
// `--pw-`. The negative lookahead is supported by modern V8 / WebKit.
// Catches `var(--accent)`, `var(--bg-muted)`, etc — the class of bug where
// devs use a different design-system's variable names by habit.
const NON_PW_VAR_PATTERN = "/var\\(--(?!pw-)/";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "src-tauri/target/**",
      "src-tauri/gen/**",
      "node_modules/**",
      "*.config.js",
      "*.config.ts",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "jsx-a11y": jsxA11y,
      react: reactPlugin,
      "react-hooks": reactHooks,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
        projectService: true,
      },
    },
    linterOptions: {
      // Pre-existing `// eslint-disable-next-line @typescript-eslint/no-explicit-any`
      // directives are common across the codebase. Since we don't enable that
      // rule here, they'd all flag as unused. Silenced.
      reportUnusedDisableDirectives: "off",
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      "no-restricted-syntax": [
        "error",
        {
          selector: `JSXAttribute[name.name='style'] Literal[value=${HEX_COLOR_PATTERN}]`,
          message:
            "Hex color literal in inline JSX style. Use a design-system token (var(--pw-*)). If this color must be hardcoded (brand identity, contrast-pair text on arbitrary background, typed icon), add // eslint-disable-next-line no-restricted-syntax -- justification.",
        },
        {
          selector: `JSXAttribute[name.name='style'] TemplateElement[value.raw=${HEX_COLOR_PATTERN}]`,
          message:
            "Hex color literal in template-literal inline JSX style. Use a design-system token (var(--pw-*)).",
        },
        {
          selector: `JSXAttribute[name.name='style'] Literal[value=${RAW_COLOR_FN_PATTERN}]`,
          message:
            "Raw rgb/rgba/hsl call in inline JSX style. Use color-mix(in srgb, var(--pw-*) N%, transparent) or var(--pw-shadow-color)/var(--pw-accent)/etc so the color follows the theme.",
        },
        {
          selector: `JSXAttribute[name.name='style'] Literal[value=${NON_PW_VAR_PATTERN}]`,
          message:
            "CSS variable in inline JSX style is not prefixed --pw-. The design system uses --pw-* tokens exclusively; var(--accent), var(--bg-muted), etc. are undefined and fall back to a hardcoded value. Use the right --pw-* token.",
        },
      ],
      "react-hooks/rules-of-hooks": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-array-delete": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-for-in-array": "error",
      "@typescript-eslint/no-implied-eval": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: true } },
      ],
      "@typescript-eslint/no-misused-spread": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "error",
      "@typescript-eslint/unbound-method": "error",
    },
  },
);
