export function abComparisonKey(
  variantLabel: string | null | undefined,
  variantIndex: number,
): string {
  const label = variantLabel?.trim();
  return `control_vs_${label || variantIndex}`;
}
