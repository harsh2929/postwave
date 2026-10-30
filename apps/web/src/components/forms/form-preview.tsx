// SPDX-License-Identifier: AGPL-3.0-only
//
// Sandboxed iframe preview of a compiled form. Mirrors the email
// PreviewPane: srcDoc-based, isolated styles, no script execution from the
// host page. Used in the Builder tab's right rail and in the Embed page
// "live preview" card.
//
// FORM-042: light/dark theme + desktop/mobile width toggles, so the preview
// isn't a jarring bright block in the app's dark mode and can show mobile
// rendering. The toggles are optional (Embed page keeps a static card).
"use client";

import { useMemo, useState } from "react";
import { Monitor, Moon, Smartphone, Sun } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { compileFormHtml, type Form } from "@/lib/forms-types";

interface FormPreviewProps {
  form: Form;
  /** Iframe pixel height; defaults to 480. */
  height?: number;
  /** Optional container class. */
  className?: string;
  /** Show the theme / device toggle bar. Default true. */
  controls?: boolean;
}

type PreviewTheme = "light" | "dark";
type PreviewDevice = "desktop" | "mobile";

function previewCss(theme: PreviewTheme): string {
  const dark = theme === "dark";
  const page = dark ? "#0b1120" : "#f8fafc";
  const card = dark ? "#111827" : "#ffffff";
  const border = dark ? "#1f2937" : "#e2e8f0";
  const text = dark ? "#e5e7eb" : "#0f172a";
  const muted = dark ? "#94a3b8" : "#475569";
  const inputBorder = dark ? "#334155" : "#cbd5e1";
  const inputBg = dark ? "#0b1120" : "#ffffff";
  const submitBg = dark ? "#6366f1" : "#0f172a";
  const submitHover = dark ? "#4f46e5" : "#1e293b";
  const focus = dark ? "#818cf8" : "#0f172a";
  return `
  :root { color-scheme: ${theme}; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    margin: 0;
    padding: 24px;
    background: ${page};
    color: ${text};
  }
  .postwave-form {
    max-width: 480px;
    margin: 0 auto;
    background: ${card};
    border: 1px solid ${border};
    border-radius: 12px;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    box-shadow: 0 1px 3px rgba(15,23,42,0.06);
  }
  .postwave-form h2.pw-heading { margin: 0 0 4px 0; font-size: 20px; font-weight: 600; }
  .postwave-form p.pw-text { margin: 0; color: ${muted}; font-size: 14px; }
  .postwave-form .pw-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: ${muted}; }
  .postwave-form .pw-field input,
  .postwave-form .pw-field select,
  .postwave-form .pw-field textarea {
    padding: 8px 12px;
    border: 1px solid ${inputBorder};
    border-radius: 8px;
    font-size: 14px;
    background: ${inputBg};
    color: ${text};
  }
  .postwave-form .pw-field input:focus,
  .postwave-form .pw-field select:focus,
  .postwave-form .pw-field textarea:focus { outline: 2px solid ${focus}; outline-offset: 1px; }
  .postwave-form .pw-checkbox { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; color: ${muted}; }
  .postwave-form .pw-fieldset { border: 1px solid ${border}; border-radius: 8px; padding: 10px 12px; color: ${muted}; font-size: 13px; }
  .postwave-form .pw-fieldset legend { padding: 0 4px; }
  .postwave-form .pw-radio, .postwave-form .pw-scale-opt { display: inline-flex; gap: 6px; align-items: center; margin-right: 12px; }
  .postwave-form button.pw-submit {
    height: 40px;
    background: ${submitBg};
    color: #ffffff;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .postwave-form button.pw-submit:hover { background: ${submitHover}; }
`;
}

export function FormPreview({
  form,
  height = 480,
  className,
  controls = true,
}: FormPreviewProps) {
  const [theme, setTheme] = useState<PreviewTheme>("light");
  const [device, setDevice] = useState<PreviewDevice>("desktop");

  const srcDoc = useMemo(() => {
    const body = compileFormHtml(form);
    return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><style>${previewCss(theme)}</style></head><body>${body}</body></html>`;
  }, [form, theme]);

  const frame = (
    <iframe
      title={`Preview of ${form.name}`}
      // sandbox="" (no flags) — inline CSS still works, but the iframe
      // document can't reach parent-origin cookies/storage and can't
      // fire credentialed cross-origin requests. Matches editor
      // preview-pane and email-preview posture.
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className="w-full border-0 bg-transparent"
      style={{ height }}
    />
  );

  if (!controls) {
    return (
      <div className={className ?? "w-full bg-background border rounded-md"}>
        {frame}
      </div>
    );
  }

  return (
    <div className={cn("rounded-md border bg-background", className)}>
      <div className="flex items-center justify-end gap-1 border-b bg-muted/30 px-2 py-1.5">
        <div className="mr-auto text-xs text-muted-foreground">
          {device === "mobile" ? "Mobile · 390px" : "Desktop"}
        </div>
        <IconButton
          aria-label="Light preview"
          size="sm"
          variant={theme === "light" ? "secondary" : "ghost"}
          onClick={() => setTheme("light")}
        >
          <Sun className="h-4 w-4" />
        </IconButton>
        <IconButton
          aria-label="Dark preview"
          size="sm"
          variant={theme === "dark" ? "secondary" : "ghost"}
          onClick={() => setTheme("dark")}
        >
          <Moon className="h-4 w-4" />
        </IconButton>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <IconButton
          aria-label="Desktop width"
          size="sm"
          variant={device === "desktop" ? "secondary" : "ghost"}
          onClick={() => setDevice("desktop")}
        >
          <Monitor className="h-4 w-4" />
        </IconButton>
        <IconButton
          aria-label="Mobile width"
          size="sm"
          variant={device === "mobile" ? "secondary" : "ghost"}
          onClick={() => setDevice("mobile")}
        >
          <Smartphone className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="flex justify-center overflow-auto p-3" style={{ minHeight: height }}>
        <div
          className={cn("transition-[width] duration-200", device === "mobile" && "shadow-pw-lg")}
          style={{ width: device === "mobile" ? 390 : "100%", maxWidth: "100%" }}
        >
          {frame}
        </div>
      </div>
    </div>
  );
}
