// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

export const InstallPromptLoader = dynamic(
  () => import("@/components/install-prompt").then((mod) => mod.InstallPrompt),
  { ssr: false },
);
