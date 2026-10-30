// SPDX-License-Identifier: AGPL-3.0-only
//
// Multi-client email preview. Renders a tab strip + viewport-shaped
// iframe that displays how the supplied MJML approximately renders in
// Gmail web, Outlook desktop, Apple Mail (iOS), and a dark-mode variant.
//
// IMPORTANT: this is an approximation, not Litmus. The HTML is produced
// by applying documented client quirks server-side (see
// apps/api/internal/emailpreview/clients.go). The iframe sandbox is
// `sandbox=""` (no flags), matching the editor preview-pane: no
// scripts, no plugins, AND no same-origin — so even passive CSS exfil
// (`background:url(//attacker)`) runs as an opaque cross-origin
// request, not one that carries the parent's cookies/storage.
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  EMAIL_CLIENTS,
  EmailClientId,
  EmailPreviewResponse,
  renderEmailPreview,
} from "@/lib/email-preview-api";

interface EmailPreviewProps {
  mjml: string;
  vars?: Record<string, string>;
}

export function EmailPreview({ mjml, vars }: EmailPreviewProps) {
  const [activeTab, setActiveTab] = React.useState<EmailClientId>("gmail");
  const [busy, setBusy] = React.useState(false);
  const [preview, setPreview] = React.useState<EmailPreviewResponse | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);

  // We deliberately don't auto-fetch on mount — the parent might be
  // editing the MJML and a request-per-keystroke would hammer the API.
  // The "Refresh preview" button is the explicit trigger.
  const refresh = React.useCallback(async () => {
    if (!mjml.trim()) {
      setError("MJML is empty.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await renderEmailPreview({ mjml, vars });
      setPreview(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [mjml, vars]);

  // Convenience: trigger an initial render once the component mounts so
  // the iframe isn't empty on first paint, but only if we haven't been
  // mounted with empty MJML.
  React.useEffect(() => {
    if (mjml.trim() && preview === null && !busy && error === null) {
      void refresh();
    }
  }, [busy, error, mjml, preview, refresh]);

  const activeClient =
    EMAIL_CLIENTS.find((c) => c.id === activeTab) ?? EMAIL_CLIENTS[0];
  const html = preview?.previews?.[activeTab] ?? "";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border bg-muted p-1">
          {EMAIL_CLIENTS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveTab(c.id)}
              className={
                "px-3 py-1 text-sm rounded-md transition-colors " +
                (c.id === activeTab
                  ? "bg-background text-foreground shadow"
                  : "text-muted-foreground hover:text-foreground")
              }
              aria-pressed={c.id === activeTab}
            >
              {c.label}
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={busy}
        >
          {busy ? "Rendering…" : "Refresh preview"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{activeClient.description}</p>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-emphasis"
        >
          {error}
        </div>
      ) : null}

      {preview && preview.warnings?.length > 0 ? (
        <div
          role="status"
          className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-900 dark:border-yellow-700/60 dark:bg-yellow-950/40 dark:text-yellow-200"
        >
          <p className="font-medium mb-1">Renderer notes</p>
          <ul className="list-disc list-inside space-y-0.5">
            {preview.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card>
        <CardContent className="p-4">
          <div className="flex justify-center bg-neutral-100 dark:bg-neutral-900 rounded p-4 overflow-auto">
            {/*
              Sandbox: `sandbox=""` (no flags). Inline <style> still
              applies — sandboxing doesn't disable CSS. `allow-same-
              origin` would let the iframe document read parent-origin
              cookies/localStorage and fire CSS resource loads with
              parent credentials; removing it closes both vectors. The
              editor preview-pane uses the same posture.
            */}
            <iframe
              key={activeTab /* force fresh iframe on tab change */}
              title={`${activeClient.label} preview`}
              srcDoc={html}
              sandbox=""
              referrerPolicy="no-referrer"
              style={{
                width: `${activeClient.viewportWidth}px`,
                height: "640px",
                border: "1px solid var(--border, #e5e7eb)",
                background: "white",
              }}
            />
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Approximations based on documented client quirks. Not pixel-perfect —
        test in real clients before sending high-stakes campaigns.
      </p>
    </div>
  );
}
