/**
 * Categorical chart palette (Phase-3 design-system pass).
 *
 * Five perceptually-distinct hues from the --pw-data-* design tokens
 * (teal / violet / amber / rose / sky), each with a light-theme variant
 * defined in styles.css. --pw-data-1 IS the brand accent, so a single
 * series stays on-brand while multi-series charts read as distinct
 * lines / bars / segments instead of monochrome-teal gradations.
 */
export const CHART_PALETTE: readonly string[] = [
  "var(--pw-data-1)",
  "var(--pw-data-2)",
  "var(--pw-data-3)",
  "var(--pw-data-4)",
  "var(--pw-data-5)",
];
