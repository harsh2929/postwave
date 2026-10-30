import { type ReactElement } from "react";

// SUB-075: deterministic hashed-hue avatar so duplicate-looking emails
// (alice@a.com vs alice@b.com) get visually distinct circles without
// us storing a colour per subscriber.
function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return ((h % 360) + 360) % 360;
}

function initialFor(name: string | undefined, email: string): string {
  const src = (name && name.trim()) || email || "?";
  const ch = src.trim().charAt(0).toUpperCase();
  return /[A-Z0-9]/.test(ch) ? ch : "?";
}

interface AvatarProps {
  email: string;
  name?: string;
  size?: number;
}

export function Avatar({ email, name, size = 24 }: AvatarProps): ReactElement {
  const seed = (email || name || "").toLowerCase();
  const hue = hashHue(seed);
  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `hsl(${hue} 60% 88%)`,
        color: `hsl(${hue} 70% 28%)`,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.45),
        fontWeight: 600,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {initialFor(name, email)}
    </div>
  );
}
