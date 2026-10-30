/**
 * DynamicContentPanel — Workstream 2 (D) editor affordance for
 * `{{#if KEY}}A{{else}}B{{/if}}` regions in a campaign body.
 *
 * Three responsibilities:
 *   1. Hit GET /api/v1/campaigns/{id}/regions to enumerate the parsed
 *      regions and surface each KEY with a true / false / default
 *      toggle. Picking a branch swaps the rendered preview locally
 *      (no API round-trip) so the operator can sanity-check how the
 *      body looks for any subscriber state.
 *   2. Render the previewed body via <EmailPreviewTabs/> so the
 *      operator sees the same client breakdown as the regular preview.
 *   3. Expose an "+ Region" button that inserts a region skeleton
 *      into a parent-supplied body string via `onInsertSkeleton`.
 *
 * The body is owned by the parent (the slideover's draft editor or
 * the new-campaign modal) — this component is stateless w.r.t. the
 * source body and only mutates the rendered preview.
 */

import { type ReactElement, useEffect, useMemo, useState } from "react";

import {
  type CampaignRegion,
  type CampaignRegionsResponse,
  api,
} from "../lib/api-client";
import { ChoiceGroup, type ChoiceGroupOption } from "./ChoiceGroup";
import { EmailPreviewTabs } from "./EmailPreviewTabs";
import { ReplyQuotePicker } from "./ReplyQuotePicker";
import { SectionHeader } from "./SectionHeader";

type BranchPick = "true" | "false" | "default";

interface Props {
  campaignID: string | number | undefined;
  /**
   * Current draft body. Used both as the source we parse-render and
   * as the seed when the operator clicks "+ Region" (the parent
   * receives the new body via onInsertSkeleton).
   */
  body: string;
  /**
   * The body as last persisted on the server. The regions endpoint
   * parses the PERSISTED body, so its byte offsets are only valid
   * against this string. When `body` differs (unsaved local edits),
   * branch picks are disabled and the preview falls back to the raw
   * draft — splicing saved-body offsets into a diverged draft would
   * corrupt the preview.
   */
  savedBody?: string;
  /**
   * Optional hook the parent wires when the body is editable.
   * Receives the new body with a region skeleton appended; when not
   * provided, the "+ Region" button is hidden.
   */
  onInsertSkeleton?: (nextBody: string) => void;
}

/** Debounce for the regions fetch — typing in the body editor should
 *  not generate a parse round-trip per keystroke. */
const REGIONS_DEBOUNCE_MS = 400;

const REGION_SKELETON =
  "\n{{#if EXAMPLE_FLAG}}\n  <p>Shown when EXAMPLE_FLAG is true.</p>\n{{else}}\n  <p>Default copy for everyone else.</p>\n{{/if}}\n";

/**
 * GAP-3#5: the backend reports Region.Start/End as Go UTF-8 BYTE offsets
 * (`strings.Index` into the original body), but JS `String.slice` counts
 * UTF-16 code units. Any non-ASCII char before a region shifts every byte
 * offset relative to the JS index (one 'é' = 2 bytes / 1 unit, an emoji =
 * up to 4 bytes / 2 units), so splicing raw byte offsets corrupts the
 * preview. Build a byte-offset → UTF-16-index map from the body so region
 * boundaries land on the right characters.
 */
function buildByteToUtf16Map(body: string): number[] {
  const enc = new TextEncoder();
  const map: number[] = [];
  let bytePos = 0;
  let jsPos = 0;
  while (jsPos < body.length) {
    const cp = body.codePointAt(jsPos);
    if (cp === undefined) break;
    const unit = String.fromCodePoint(cp);
    const nbytes = enc.encode(unit).length;
    // Every byte of this character maps back to the char's JS start index;
    // region boundaries always fall on char boundaries (ASCII handlebars).
    for (let b = 0; b < nbytes; b++) map[bytePos + b] = jsPos;
    bytePos += nbytes;
    jsPos += unit.length; // 1, or 2 for a surrogate pair
  }
  map[bytePos] = jsPos; // end sentinel === body.length
  return map;
}

/** Render a body with each region collapsed to the picked branch. */
function applyPicks(
  body: string,
  regions: CampaignRegion[],
  picks: Record<string, BranchPick>,
): string {
  const byteToJs = buildByteToUtf16Map(body);
  const toJs = (byteOffset: number): number =>
    byteToJs[byteOffset] ?? body.length;
  // Process regions back-to-front by start offset so the ranges we splice
  // stay valid as we mutate later/earlier sections.
  const ordered = [...regions].sort((a, b) => b.start - a.start);
  let out = body;
  for (const r of ordered) {
    const startJs = toJs(r.start);
    const endJs = toJs(r.end);
    const pick = picks[r.key] ?? "default";
    let replacement = body.slice(startJs, endJs);
    if (pick === "true") {
      replacement = r.true_branch;
    } else if (pick === "false") {
      replacement = r.has_else ? r.false_branch : "";
    }
    out = out.slice(0, startJs) + replacement + out.slice(endJs);
  }
  return out;
}

export function DynamicContentPanel({
  campaignID,
  body,
  savedBody,
  onInsertSkeleton,
}: Props): ReactElement {
  const [resp, setResp] = useState<CampaignRegionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, BranchPick>>({});

  // Offsets desync guard: the server parsed the persisted body, so
  // when the local draft has diverged from it, the byte offsets in
  // `resp.regions` no longer line up with `body`. When the parent
  // doesn't provide `savedBody` we can't tell, so we trust `body`
  // (read-only callers pass the persisted body anyway).
  const bodyDesynced = savedBody !== undefined && body !== savedBody;

  // GAP-3#13: the regions endpoint parses the PERSISTED campaign body, so
  // its result can't change until the campaign is saved. Key the load on
  // savedBody (the only input the server actually parses) rather than the
  // draft `body` — re-fetching on every keystroke returned byte-identical
  // data. Read-only callers pass no savedBody, so the load runs once per
  // campaign on mount; editing callers re-fetch when a save changes it.
  // The debounce still guards the save→refetch transition.
  useEffect(() => {
    if (campaignID == null) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void (async () => {
        const res = await api.getCampaignRegions(campaignID);
        if (cancelled) return;
        if (res.error) {
          setErr(res.error.message);
          setResp(null);
        } else {
          setErr(null);
          setResp(res.data);
        }
        setLoading(false);
      })();
    }, REGIONS_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [campaignID, savedBody]);

  const regions = resp?.regions ?? [];

  const preview = useMemo<string>(() => {
    if (regions.length === 0) return body;
    // Never splice saved-body offsets into a diverged draft.
    if (bodyDesynced) return body;
    return applyPicks(body, regions, picks);
  }, [body, regions, picks, bodyDesynced]);

  const [quoteOpen, setQuoteOpen] = useState(false);

  const insertSkeleton = (): void => {
    if (!onInsertSkeleton) return;
    onInsertSkeleton(body + REGION_SKELETON);
  };

  // G3: append an attributed reader-quote blockquote to the body. The
  // excerpt is HTML-escaped so a reply containing markup can't inject
  // into the campaign body.
  const insertQuote = (quote: { excerpt: string; fromEmail: string }): void => {
    if (!onInsertSkeleton) return;
    const esc = (s: string): string =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const block = `\n<blockquote class="pw-reader-quote">\n  <p>${esc(
      quote.excerpt,
    )}</p>\n  <p class="pw-reader-attrib">— ${esc(quote.fromEmail)}</p>\n</blockquote>\n`;
    onInsertSkeleton(body + block);
  };

  return (
    <div style={{ marginTop: 16 }}>
      <SectionHeader
        title="Dynamic content"
        description="Conditional regions in the body. Toggle a branch to see how it renders for each audience state."
        helpText="Syntax: {{#if KEY}}…{{else}}…{{/if}}. Subscribers where KEY is truthy see the first branch, everyone else sees the {{else}} branch."
        actions={
          onInsertSkeleton ? (
            <span style={{ display: "inline-flex", gap: 6 }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={insertSkeleton}
              >
                + Region
              </button>
              {campaignID != null ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setQuoteOpen(true)}
                >
                  + Quote a reader reply
                </button>
              ) : null}
            </span>
          ) : undefined
        }
      />

      {err ? (
        <div className="notice">Couldn&apos;t parse regions: {err}</div>
      ) : null}

      {bodyDesynced && regions.length > 0 ? (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Save the campaign body first to edit regions — branch previews are
          computed against the last saved body.
        </div>
      ) : null}

      {regions.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          {loading
            ? "Scanning body for regions…"
            : "No dynamic regions in this body yet."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
          {regions.map((r) => {
            const pick = picks[r.key] ?? "default";
            const branchOptions: readonly ChoiceGroupOption<BranchPick>[] = [
              { value: "default", label: "Default" },
              { value: "true", label: "True branch" },
              {
                value: "false",
                label: "Else branch",
                ...(!r.has_else
                  ? {
                      unavailable: true,
                      description: "This region has no {{else}} branch.",
                    }
                  : {}),
              },
            ];
            return (
              <div
                key={`${r.key}-${r.start}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: 10,
                  alignItems: "center",
                  padding: "8px 0",
                  borderTop: "1px solid var(--pw-border)",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {r.key}
                    {r.has_else ? (
                      <span
                        className="muted"
                        style={{ marginLeft: 6, fontSize: 11 }}
                      >
                        if / else
                      </span>
                    ) : null}
                  </div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    Bytes {r.start}–{r.end}
                    {r.children && r.children.length > 0
                      ? ` · ${r.children.length} nested`
                      : ""}
                  </div>
                </div>
                <ChoiceGroup
                  legend={`Preview branch for ${r.key}`}
                  value={pick}
                  options={branchOptions}
                  onChange={(next) =>
                    setPicks((previous) => ({
                      ...previous,
                      [r.key]: next,
                    }))
                  }
                  disabled={bodyDesynced}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Live preview of the body with picks applied. */}
      <EmailPreviewTabs body={preview} />

      {campaignID != null ? (
        <ReplyQuotePicker
          open={quoteOpen}
          onClose={() => setQuoteOpen(false)}
          campaignId={campaignID}
          onPick={insertQuote}
        />
      ) : null}
    </div>
  );
}
