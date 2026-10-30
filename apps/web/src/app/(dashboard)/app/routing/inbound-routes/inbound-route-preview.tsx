// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import { FlaskConical, RotateCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import {
  previewInboundRoutesStrict,
  type InboundRoutePreview,
} from "@/lib/inbound-routes-admin-api";

export function InboundRoutePreviewPanel({ me }: { me: MeResponse }) {
  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState("");
  const [from, setFrom] = useState("");
  const [result, setResult] = useState<InboundRoutePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  function change(setter: (value: string) => void, value: string) {
    setter(value);
    setResult(null);
    setError(null);
    request.current?.abort();
    setRunning(false);
  }

  async function preview() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await previewInboundRoutesStrict({
          tenantId: me.tenant_id,
          recipient,
          subject,
          from,
          signal: controller.signal,
        }),
      );
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(apiErrorMessage(cause, "The dry-run preview could not be completed"));
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }

  function reset() {
    request.current?.abort();
    setRecipient("");
    setSubject("");
    setFrom("");
    setResult(null);
    setError(null);
    setRunning(false);
  }

  return (
    <section aria-labelledby="inbound-preview-heading" className="space-y-4 rounded-lg border p-4">
      <div>
        <h2 id="inbound-preview-heading" className="text-lg font-semibold">
          Dry-run matcher preview
        </h2>
        <p className="text-sm text-muted-foreground">
          Evaluates the mounted matcher only. It does not execute actions,
          increment counters, persist an email, or prove delivery.
        </p>
      </div>
      <form
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          void preview();
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="inbound-preview-recipient">Recipient</Label>
          <Input
            id="inbound-preview-recipient"
            required
            maxLength={320}
            autoComplete="off"
            value={recipient}
            onChange={(event) => change(setRecipient, event.target.value)}
            placeholder="support@example.com"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="inbound-preview-subject">Subject (optional)</Label>
          <Input
            id="inbound-preview-subject"
            maxLength={998}
            autoComplete="off"
            value={subject}
            onChange={(event) => change(setSubject, event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="inbound-preview-from">From address (optional)</Label>
          <Input
            id="inbound-preview-from"
            maxLength={320}
            autoComplete="off"
            value={from}
            onChange={(event) => change(setFrom, event.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2 sm:col-span-3">
          <Button type="submit" disabled={running || !recipient.trim()}>
            <FlaskConical aria-hidden className="size-4" />
            {running ? "Evaluating…" : "Run dry preview"}
          </Button>
          <Button type="button" variant="ghost" disabled={running} onClick={reset}>
            <RotateCcw aria-hidden className="size-4" /> Clear inputs
          </Button>
        </div>
      </form>
      {running ? (
        <p role="status" className="text-sm text-muted-foreground">
          Evaluating the current route catalogue…
        </p>
      ) : error ? (
        <div role="alert" className="rounded-md border border-destructive p-3 text-sm">
          {error}
        </div>
      ) : result?.noMatches ? (
        <div role="status" className="rounded-md border p-4 text-sm">
          Verified no match after evaluating {result.evaluated.toLocaleString()} route
          {result.evaluated === 1 ? "" : "s"}.
        </div>
      ) : result ? (
        <div className="space-y-3">
          <p role="status" className="text-sm">
            {result.matches.length.toLocaleString()} match
            {result.matches.length === 1 ? "" : "es"} from {result.evaluated.toLocaleString()} evaluated route
            {result.evaluated === 1 ? "" : "s"}.
          </p>
          <ol className="space-y-2">
            {result.matches.map((hit) => (
              <li key={hit.route.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{hit.route.name || "Untitled route"}</strong>
                  <Badge variant={hit.route.enabled ? "outline" : "warning"}>
                    {hit.route.enabled ? "enabled" : "disabled · hypothetical"}
                  </Badge>
                  {result.stoppedAtRouteId === hit.route.id ? (
                    <Badge variant="secondary">evaluation stopped here</Badge>
                  ) : null}
                </div>
                <p className="mt-1 text-muted-foreground">{hit.reason}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
