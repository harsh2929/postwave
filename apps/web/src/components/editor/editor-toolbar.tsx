// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Save,
  Undo2,
  Redo2,
  Smartphone,
  Monitor,
  Sun,
  Moon,
} from "lucide-react";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PreviewMode, PreviewTheme } from "./preview-pane";

interface EditorToolbarProps {
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  previewMode: PreviewMode;
  onPreviewModeChange: (m: PreviewMode) => void;
  previewTheme: PreviewTheme;
  onPreviewThemeChange: (t: PreviewTheme) => void;
  saving?: boolean;
  rightSlot?: React.ReactNode;
}

export function EditorToolbar({
  onSave,
  onUndo,
  onRedo,
  previewMode,
  onPreviewModeChange,
  previewTheme,
  onPreviewThemeChange,
  saving,
  rightSlot,
}: EditorToolbarProps) {
  // aria-live region for undo/redo announcements. The inner text changes
  // briefly so a screen-reader user gets feedback that the action fired.
  const [historyAnnouncement, setHistoryAnnouncement] = useState("");
  useEffect(() => {
    if (!historyAnnouncement) return;
    const t = setTimeout(() => setHistoryAnnouncement(""), 1500);
    return () => clearTimeout(t);
  }, [historyAnnouncement]);

  return (
    <div
      className="h-12 flex items-center justify-between gap-2 border-b bg-card px-3"
      role="toolbar"
      aria-label="Editor toolbar"
    >
      <span aria-live="polite" className="sr-only">
        {historyAnnouncement}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onUndo();
            setHistoryAnnouncement("Undid last change");
          }}
          type="button"
          aria-label="Undo last change"
          className="focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Undo2 className="h-4 w-4" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onRedo();
            setHistoryAnnouncement("Redid last change");
          }}
          type="button"
          aria-label="Redo last change"
          className="focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Redo2 className="h-4 w-4" aria-hidden />
        </Button>
        <span className="mx-2 h-5 w-px bg-border" aria-hidden />
        <ToggleGroup
          label="Preview size"
          value={previewMode}
          options={[
            { value: "desktop", icon: Monitor, label: "Desktop preview" },
            { value: "mobile", icon: Smartphone, label: "Mobile preview" },
          ]}
          onChange={(v) => onPreviewModeChange(v as PreviewMode)}
        />
        <span className="mx-2 h-5 w-px bg-border" aria-hidden />
        <ToggleGroup
          label="Preview theme"
          value={previewTheme}
          options={[
            { value: "light", icon: Sun, label: "Light preview" },
            { value: "dark", icon: Moon, label: "Dark preview" },
          ]}
          onChange={(v) => onPreviewThemeChange(v as PreviewTheme)}
        />
      </div>
      <div className="flex items-center gap-2">
        {rightSlot}
        <Button size="sm" onClick={onSave} disabled={saving} type="button">
          <Save className="h-4 w-4" />
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

interface ToggleOption {
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}

function ToggleGroup({
  label,
  value,
  options,
  onChange,
}: {
  // The toolbar renders two of these side by side; without a name each one
  // announces only as "radiogroup", indistinguishable from the other.
  label: string;
  value: string;
  options: ToggleOption[];
  onChange: (v: string) => void;
}) {
  return (
    <div
      className="inline-flex rounded-md border bg-background p-0.5"
      role="radiogroup"
      aria-label={label}
    >
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = opt.value === value;
        return (
          <button
            type="button"
            key={opt.value}
            onClick={() => onChange(opt.value)}
            aria-label={opt.label}
            role="radio"
            aria-checked={active}
            className={cn(
              "h-7 w-7 inline-flex items-center justify-center rounded-sm text-muted-foreground transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active && "bg-accent text-accent-foreground",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
