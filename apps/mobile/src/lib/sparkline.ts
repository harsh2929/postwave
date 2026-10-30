export type SparklinePoint = { x: number; y: number };

/** Pure chart geometry shared by the SVG component and regression tests. */
export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
  padX = 2,
  padY = 2,
): SparklinePoint[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const innerW = Math.max(0, width - padX * 2);
  const innerH = Math.max(0, height - padY * 2);
  const step = values.length > 1 ? innerW / (values.length - 1) : innerW;
  const isConstant = max === min;
  return values.map((value, index) => ({
    x: padX + step * index,
    y: isConstant
      ? padY + innerH / 2
      : padY + innerH - ((value - min) / (max - min)) * innerH,
  }));
}
