export const TAG_PALETTE: ReadonlyArray<{
  id: string;
  label: string;
  bg: string;
}> = [
  { id: "slate", label: "Slate", bg: "#64748b" },
  { id: "teal", label: "Teal", bg: "#14b8a6" },
  { id: "sky", label: "Sky", bg: "#0ea5e9" },
  { id: "indigo", label: "Indigo", bg: "#6366f1" },
  { id: "violet", label: "Violet", bg: "#8b5cf6" },
  { id: "rose", label: "Rose", bg: "#f43f5e" },
  { id: "amber", label: "Amber", bg: "#f59e0b" },
  { id: "lime", label: "Lime", bg: "#84cc16" },
];

export const DEFAULT_TAG_COLOR = TAG_PALETTE[0]!.id;

const HEX_COLOR = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/iu;

export interface TagColorPresentation {
  background: string;
  label: string;
  legacy: boolean;
}

/**
 * Converts untrusted, bounded legacy metadata into a safe visual token. Raw
 * legacy strings never reach a CSS declaration.
 */
export function tagColorPresentation(
  value: string | null | undefined,
): TagColorPresentation {
  if (!value) {
    return {
      background: TAG_PALETTE[0]!.bg,
      label: TAG_PALETTE[0]!.label,
      legacy: false,
    };
  }
  const palette = TAG_PALETTE.find(
    (candidate) => candidate.id === value.toLowerCase(),
  );
  if (palette) {
    return {
      background: palette.bg,
      label: palette.label,
      legacy: false,
    };
  }
  if (HEX_COLOR.test(value)) {
    return { background: value, label: value.toUpperCase(), legacy: false };
  }
  return {
    background: TAG_PALETTE[0]!.bg,
    label: "Legacy colour shown as neutral slate",
    legacy: true,
  };
}

export function isSupportedTagColor(value: string): boolean {
  return !tagColorPresentation(value).legacy;
}
