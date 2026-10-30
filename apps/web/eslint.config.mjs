// SPDX-License-Identifier: AGPL-3.0-only
import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  {
    ignores: [".next/**", ".next-*/**", "next-env.d.ts", "public/**"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      // Promise rejections must never disappear at a client boundary. React
      // event attributes intentionally accept void callbacks, so those remain
      // outside this rule until they can be migrated without false positives.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
      // The codebase already writes `_name` to mean "deliberately unused" and
      // uses `{ omitted, ...rest }` to strip a prop before spreading. Neither
      // convention was honoured by the inherited defaults, so intentional code
      // produced warnings and `--max-warnings=0` turned them into gate
      // failures. Honour both explicitly instead of leaving the conventions
      // decorative.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
];

export default eslintConfig;
