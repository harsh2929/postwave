// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/** Applies the visitor's OS motion preference to every Forge motion study. */
export function ForgeMotionPolicy({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
