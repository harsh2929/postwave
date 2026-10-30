// SPDX-License-Identifier: AGPL-3.0-only

// Brand confetti palette — ember + the single gold spark, matching the brand
// (kept in sync with the desktop celebration).
const CONFETTI_COLORS = ["#C8102E", "#F2B233", "#9F0C24", "#F08591", "#FDFCF8"];

/**
 * celebrate() — a one-shot, brand-colored confetti burst for genuine wins
 * (campaign sent, first import, milestones). Self-contained: builds DOM pieces
 * and animates them with the Web Animations API (no CSS keyframe dependency),
 * then removes them.
 *
 * Delight is rare, earned, and dismissible: fire it only on real wins, and it
 * self-disables under prefers-reduced-motion.
 */
export function celebrate(opts?: { count?: number }): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  // Accessibility is the craft: no motion for users who asked for none.
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;

  const count = opts?.count ?? 80;
  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden";
  document.body.appendChild(container);

  const originX = window.innerWidth / 2;
  const originY = window.innerHeight * 0.42;

  for (let i = 0; i < count; i++) {
    const piece = document.createElement("div");
    const size = 6 + Math.round(Math.random() * 6);
    const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.cssText = `position:absolute;left:${originX}px;top:${originY}px;width:${size}px;height:${Math.round(
      size * 0.6,
    )}px;background:${color};border-radius:1px;will-change:transform,opacity`;
    container.appendChild(piece);

    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5);
    const velocity = 120 + Math.random() * 260;
    const dx = Math.cos(angle) * velocity;
    const dy = Math.sin(angle) * velocity - (160 + Math.random() * 140);
    const rotate = (Math.random() - 0.5) * 720;
    const duration = 1100 + Math.random() * 700;

    piece.animate(
      [
        { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
        {
          transform: `translate(${dx}px, ${dy + 360}px) rotate(${rotate}deg)`,
          opacity: 0,
        },
      ],
      { duration, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" },
    );
  }

  window.setTimeout(() => container.remove(), 2000);
}
