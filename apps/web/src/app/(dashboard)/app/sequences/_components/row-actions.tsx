// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { MoreHorizontal } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import type { SequenceStatus } from "@/lib/voice-types";

const SequenceRowActionsMenu = dynamic(
  () =>
    import("./row-actions-menu").then(
      (module) => module.SequenceRowActionsMenu,
    ),
  {
    ssr: false,
    loading: () => (
      <span className="relative inline-block text-left">
        <IconButton
          size="sm"
          disabled
          aria-label="Loading sequence actions menu"
        >
          <MoreHorizontal className="h-4 w-4" />
        </IconButton>
        <span role="status" className="sr-only">
          Loading sequence actions…
        </span>
      </span>
    ),
  },
);

interface RowActionsProps {
  id: string;
  status: SequenceStatus;
  onChanged?: () => void;
}

/**
 * Keeps the mutation/menu implementation out of the list graph until an
 * operator asks for row actions. The loaded menu starts open and moves focus
 * to its first item, preserving the previous one-click keyboard behavior.
 */
export function SequenceRowActions(props: RowActionsProps) {
  const [activated, setActivated] = useState(false);

  if (activated) {
    return <SequenceRowActionsMenu {...props} initialOpen />;
  }

  return (
    <IconButton
      size="sm"
      aria-label="Open actions menu"
      aria-haspopup="menu"
      aria-expanded={false}
      onClick={() => setActivated(true)}
    >
      <MoreHorizontal className="h-4 w-4" />
    </IconButton>
  );
}
