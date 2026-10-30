// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import type { Segment } from "@/lib/segments-api";
import { writebackApi, type WritebackProvider } from "@/lib/writeback-api";
import {
  buildWritebackTargetInput,
  newWritebackRow,
  type KeyValueRow,
} from "./writeback-create-form-helpers";
import { errText, providerLabel } from "./writeback-targets-utils";

function KeyValueEditor({
  rows,
  onChange,
  sectionLabel,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  // Both editors on this form use the SAME key placeholder ("platform_field"),
  // so the placeholder alone cannot name a row: row 1 of each would answer to
  // one name. Every accessible name below is scoped by the section instead.
  sectionLabel: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}) {
  function update(i: number, patch: Partial<KeyValueRow>) {
    onChange(rows.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function remove(i: number) {
    onChange(rows.filter((_, idx) => idx !== i));
  }
  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div
          key={row.id}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.75rem] gap-2"
        >
          <input
            value={row.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            aria-label={`${sectionLabel} ${keyPlaceholder} (row ${i + 1})`}
            className="min-w-0 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
          />
          <input
            value={row.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={valuePlaceholder}
            aria-label={`${sectionLabel} ${valuePlaceholder} (row ${i + 1})`}
            className="min-w-0 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-2 text-xs text-destructive-emphasis hover:bg-destructive/5 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8 sm:min-w-8"
            aria-label={`Remove ${sectionLabel} row ${i + 1}`}
          >
            x
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, newWritebackRow()])}
        className="inline-flex min-h-11 items-center rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
      >
        + {addLabel}
      </button>
    </div>
  );
}

export function CreateWritebackForm({
  providers,
  segments,
  segmentsLoaded,
  segmentsError = false,
  onCreated,
}: {
  providers: WritebackProvider[];
  segments: Segment[];
  segmentsLoaded: boolean;
  segmentsError?: boolean;
  onCreated: () => void | Promise<void>;
}) {
  const available = providers.filter((provider) => provider.available);
  const [provider, setProvider] = useState<string>(
    available[0]?.provider ?? "",
  );
  const [name, setName] = useState("");
  const [credentialsRef, setCredentialsRef] = useState("");
  const [sourceKind, setSourceKind] = useState<"segment" | "list">("segment");
  const [sourceSegmentId, setSourceSegmentId] = useState("");
  const [sourceListId, setSourceListId] = useState("");
  const [tags, setTags] = useState("");
  const [fieldRows, setFieldRows] = useState<KeyValueRow[]>([]);
  const [traitRows, setTraitRows] = useState<KeyValueRow[]>([]);
  const [syncInterval, setSyncInterval] = useState("0");
  const [advancedJson, setAdvancedJson] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the provider once the available list arrives. Depend on `providers`
  // (a stable prop) rather than the per-render `available` array identity.
  useEffect(() => {
    const firstAvailable = providers.find((item) => item.available);
    if (!provider && firstAvailable) setProvider(firstAvailable.provider);
  }, [providers, provider]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const result = buildWritebackTargetInput({
      advancedJson,
      credentialsRef,
      fieldRows,
      name,
      provider,
      sourceKind,
      sourceListId,
      sourceSegmentId,
      syncInterval,
      tags,
      traitRows,
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setSubmitting(true);
    try {
      await writebackApi.create(result.input);
      toast.success("Write-back target created");
      await onCreated();
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.status === 401 || err.status === 403)
      ) {
        setError("Admin access is required to create a write-back target.");
      } else {
        setError(errText(err, "Create failed"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mb-6 space-y-4 rounded-md border border-border bg-card p-4"
    >
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label
            htmlFor="wb-provider"
            className="mb-1 block text-sm text-muted-foreground"
          >
            Provider
          </label>
          <select
            id="wb-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            {available.length === 0 && (
              <option value="">No write-back adapters available</option>
            )}
            {available.map((item) => (
              <option key={item.provider} value={item.provider}>
                {providerLabel(item.provider)}
              </option>
            ))}
          </select>
          {available.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              No write-back adapters are configured on this server.
            </p>
          ) : providers.some((item) => !item.available) ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Some providers are hidden - they have no adapter configured on the
              server.
            </p>
          ) : null}
        </div>
        <div>
          <label
            htmlFor="wb-name"
            className="mb-1 block text-sm text-muted-foreground"
          >
            Name (optional)
          </label>
          <input
            id="wb-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${providerLabel(provider) || "Provider"} write-back`}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="wb-credref"
          className="mb-1 block text-sm text-muted-foreground"
        >
          Credential reference
        </label>
        <input
          id="wb-credref"
          value={credentialsRef}
          onChange={(e) => setCredentialsRef(e.target.value)}
          placeholder="vault://writeback/..."
          className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
          required
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Raw credentials are never accepted - store the platform token in the
          vault and pass its reference.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          {/* Only one of the two source controls is mounted at a time, so the
              heading label points at whichever is currently rendered. */}
          <label
            htmlFor={
              sourceKind === "segment" ? "wb-source-segment" : "wb-source-list"
            }
            className="mb-1 block text-sm text-muted-foreground"
          >
            Source
          </label>
          <div className="mb-2 flex gap-3 text-xs">
            <label className="flex min-h-11 cursor-pointer items-center gap-1 rounded-md px-2 hover:bg-muted/40 focus-within:ring-2 focus-within:ring-ring sm:min-h-8">
              <input
                type="radio"
                name="writeback-source-kind"
                checked={sourceKind === "segment"}
                onChange={() => setSourceKind("segment")}
              />
              Segment
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-1 rounded-md px-2 hover:bg-muted/40 focus-within:ring-2 focus-within:ring-ring sm:min-h-8">
              <input
                type="radio"
                name="writeback-source-kind"
                checked={sourceKind === "list"}
                onChange={() => setSourceKind("list")}
              />
              List
            </label>
          </div>
          {sourceKind === "segment" ? (
            <>
              <select
                id="wb-source-segment"
                value={sourceSegmentId}
                onChange={(e) => setSourceSegmentId(e.target.value)}
                disabled={segmentsError}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">Select a segment...</option>
                {segments.map((segment) => (
                  <option key={segment.id} value={segment.id}>
                    {segment.name}
                  </option>
                ))}
              </select>
              {segmentsError ? (
                <p className="mt-1 text-xs text-destructive" role="alert">
                  Segments could not be loaded. Retry the panel or switch to a
                  list source.
                </p>
              ) : segmentsLoaded && segments.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  No segments yet - create one, or switch to List.
                </p>
              ) : null}
            </>
          ) : (
            <input
              id="wb-source-list"
              value={sourceListId}
              onChange={(e) => setSourceListId(e.target.value)}
              placeholder="list id (uuid)"
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
            />
          )}
        </div>
        <div>
          <label
            htmlFor="wb-tags"
            className="mb-1 block text-sm text-muted-foreground"
          >
            Tags to apply (comma-separated)
          </label>
          <input
            id="wb-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Moosewave-VIP, Newsletter"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Appended to the matched record on every member.
          </p>
        </div>
      </div>

      {/* A <label> can only name ONE control, and each editor below renders a
          growing set of them - so these headings are legends over a grouped
          fieldset rather than labels pointing at nothing. */}
      <fieldset className="min-w-0">
        <legend className="mb-1 block text-sm text-muted-foreground">
          Static fields (platform field -&gt; constant value)
        </legend>
        <KeyValueEditor
          rows={fieldRows}
          onChange={setFieldRows}
          sectionLabel="Static field"
          keyPlaceholder="platform_field"
          valuePlaceholder="constant value (e.g. optin)"
          addLabel="Add static field"
        />
      </fieldset>

      <fieldset className="min-w-0">
        <legend className="mb-1 block text-sm text-muted-foreground">
          Trait mapping (platform field -&gt; Moosewave trait)
        </legend>
        <KeyValueEditor
          rows={traitRows}
          onChange={setTraitRows}
          sectionLabel="Trait mapping"
          keyPlaceholder="platform_field"
          valuePlaceholder="trait key (e.g. lifetime_value)"
          addLabel="Add trait mapping"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Each member&apos;s own trait value is written - leave empty for
          constant-only sync. Predicted analytics are available too:
          _predicted_clv_cents, _churn_risk, _rfm_segment,
          _predicted_order_count, _expected_next_order_at.
        </p>
      </fieldset>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label
            htmlFor="wb-sync-interval"
            className="mb-1 block text-sm text-muted-foreground"
          >
            Auto-sync interval (minutes, 0 = manual)
          </label>
          <input
            id="wb-sync-interval"
            type="number"
            min={0}
            step={1}
            value={syncInterval}
            onChange={(e) => setSyncInterval(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label
            htmlFor="wb-advanced"
            className="mb-1 block text-sm text-muted-foreground"
          >
            Advanced settings (JSON, optional)
          </label>
          <textarea
            id="wb-advanced"
            value={advancedJson}
            onChange={(e) => setAdvancedJson(e.target.value)}
            rows={2}
            placeholder='{"shop_domain": "acme.myshopify.com"}'
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Provider-specific keys only (e.g. shop_domain, list_id, event_name,
            object).
          </p>
        </div>
      </div>

      {error && (
        <div className="text-sm text-destructive" role="alert">
          {error}
        </div>
      )}

      <Button
        type="submit"
        disabled={available.length === 0}
        loading={submitting}
        className="w-full sm:w-auto"
      >
        {submitting ? "Creating..." : "Create write-back target"}
      </Button>
    </form>
  );
}
