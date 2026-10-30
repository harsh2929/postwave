// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { addTemplateReviewEvent, listTemplateReviewEvents, type TemplateReviewEvent, type TemplateReviewKind } from "@/lib/template-review-api";

export function TemplateReviewPanel({ templateId, version, etag, canWrite }: {
  templateId: string;
  version: number;
  etag: string;
  canWrite: boolean;
}) {
  const [events, setEvents] = useState<TemplateReviewEvent[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void listTemplateReviewEvents(templateId, version, controller.signal)
      .then((page) => { if (!controller.signal.aborted) { setEvents(page.items); setTruncated(page.truncated); setError(null); } })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Review history is unavailable.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [templateId, version, reload]);

  const current = events.filter((event) => event.template_version === version);
  const latestDecision = current.find((event) => event.kind !== "comment");
  const state = latestDecision?.kind === "approve" ? "Team-approved for this version"
    : latestDecision?.kind === "request_changes" ? "Changes requested for this version"
    : "No team approval recorded for this version";

  async function submit(kind: TemplateReviewKind) {
    if (busy || (kind !== "approve" && !body.trim())) return;
    setBusy(true);
    setError(null);
    try {
      const event = await addTemplateReviewEvent({ templateId, version, etag, kind, body: kind === "approve" ? "" : body.trim() });
      setEvents((existing) => [event, ...existing]);
      setBody("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record review. Reload the template before trying again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border bg-card p-5" aria-label="Template review">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-medium">Team review · version {version}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{state}. Notes and decisions are version-bound; editing creates a new version. This team review does not replace the separate campaign send approval gate.</p>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={loading || busy} onClick={() => setReload((value) => value + 1)}>Refresh</Button>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading review history…</p> : null}
      {!loading && current.length === 0 ? <p className="text-sm text-muted-foreground">No notes on this version yet.</p> : null}
      {current.length ? <ol className="max-h-72 space-y-2 overflow-auto border-t pt-3">
        {current.map((event) => <li key={event.id} className="rounded-md border bg-muted/20 p-3 text-sm">
          <p className="font-medium">{event.kind === "approve" ? "Approved" : event.kind === "request_changes" ? "Changes requested" : "Comment"} · {event.actor_email || "Team member"}</p>
          {event.body ? <p className="mt-1 whitespace-pre-wrap break-words">{event.body}</p> : null}
          <p className="mt-1 text-xs text-muted-foreground">{new Date(event.created_at).toLocaleString()}</p>
        </li>)}
      </ol> : null}
      {truncated ? <p className="text-xs text-amber-800">Showing the latest 100 review events for this version; older events are not shown here.</p> : null}
      {canWrite ? <div className="space-y-2 border-t pt-3">
        <label htmlFor="template-review-note" className="text-sm font-medium">Note for this version</label>
        <Textarea id="template-review-note" value={body} maxLength={4000} rows={3} onChange={(event) => setBody(event.target.value)} placeholder="What should the team check or change?" />
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy || !body.trim()} onClick={() => void submit("comment")}>Add comment</Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || !body.trim()} onClick={() => void submit("request_changes")}>Request changes</Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => void submit("approve")}>Approve this version</Button>
        </div>
      </div> : null}
    </section>
  );
}
