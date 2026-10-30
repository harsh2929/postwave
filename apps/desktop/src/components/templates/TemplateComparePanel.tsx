import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";

import type { CampaignTemplate } from "../../lib/api-client";
import {
  campaignTemplateDiscoveryApi,
  type CampaignTemplateCompareItem,
} from "../../lib/api/campaign-template-discovery";
import {
  type DiscoveryFailure,
  FailureNotice,
  readableDate,
  requestFailure,
  templateLabel,
} from "./template-discovery-shared";

export interface TemplateComparePanelProps {
  compareSelection: string[];
  enabled: boolean;
  rows: CampaignTemplate[] | null;
  onCompareSelectionChange: (ids: string[]) => void;
  onOpenTemplate: (template: CampaignTemplate) => void;
}

type ReportedAvailability = "Available" | "Not reported" | "Unavailable";

export function templatePreviewAvailability(
  template: CampaignTemplate,
  variant: "desktop" | "mobile",
): ReportedAvailability {
  const capability =
    variant === "desktop"
      ? template.capabilities?.has_desktop_preview
      : template.capabilities?.has_mobile_preview;
  if (typeof capability === "boolean") {
    return capability ? "Available" : "Unavailable";
  }
  const matchingAssets =
    template.preview_assets?.filter((asset) => asset.variant === variant) ?? [];
  if (matchingAssets.some((asset) => asset.status === "ready")) {
    return "Available";
  }
  return matchingAssets.some((asset) => asset.status === "source_missing")
    ? "Unavailable"
    : "Not reported";
}

export function templateEditingAvailability(
  template: CampaignTemplate,
): string {
  if (template.capabilities?.can_edit_directly) return "Directly editable";
  if (template.capabilities?.can_adapt) return "Adaptation only";
  if (template.capabilities?.can_use_directly) {
    return "Use directly · editing unavailable";
  }
  if (template.capabilities) return "View only";
  if (template.template_kind === "editable") return "Editable template";
  if (template.template_kind === "reference") {
    return "Reference · adaptation not reported";
  }
  return "Not reported";
}

export function templateFavoriteState(template: CampaignTemplate): string {
  if (template.is_favorited === true) return "Favorited";
  if (template.is_favorited === false) return "Not favorited";
  return template.capabilities?.can_favorite === false
    ? "Unavailable"
    : "Not reported";
}

export function templateProvenance(template: CampaignTemplate): string {
  const explicit = [template.source_brand, template.source_provider].filter(
    (value, index, values): value is string =>
      Boolean(value?.trim()) &&
      values.findIndex(
        (candidate) =>
          candidate?.trim().toLocaleLowerCase() ===
          value?.trim().toLocaleLowerCase(),
      ) === index,
  );
  if (explicit.length) return explicit.join(" · ");
  if (template.tenant_id) return "Workspace-owned";
  if (template.source_url) return "Source link available";
  return "Not reported";
}

function reviewLabel(template: CampaignTemplate): string {
  const status = template.review_status
    ? template.review_status[0]?.toLocaleUpperCase() +
      template.review_status.slice(1)
    : "Not reported";
  return typeof template.quality_score === "number"
    ? `${status} · ingestion quality ${Math.round(template.quality_score * 100)}%`
    : status;
}

export function TemplateComparePanel({
  compareSelection,
  enabled,
  rows,
  onCompareSelectionChange,
  onOpenTemplate,
}: TemplateComparePanelProps): ReactElement {
  const [comparison, setComparison] = useState<
    CampaignTemplateCompareItem[] | null
  >(null);
  const [comparisonKey, setComparisonKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<DiscoveryFailure | null>(null);
  const [availabilityNotice, setAvailabilityNotice] = useState("");
  const [collectionMemberships, setCollectionMemberships] = useState<
    Map<string, string[]> | null
  >(null);
  const [pickerId, setPickerId] = useState("");
  const comparisonSequence = useRef(0);
  const templates = useMemo(
    () => new Map((rows ?? []).map((row) => [row.id, row])),
    [rows],
  );
  const selectionKey = compareSelection.join("\u0000");
  const latestSelectionKey = useRef(selectionKey);
  latestSelectionKey.current = selectionKey;
  const resultsStale = comparison !== null && comparisonKey !== selectionKey;
  const canRun =
    compareSelection.length >= 2 && compareSelection.length <= 4 && !loading;

  useEffect(() => {
    comparisonSequence.current += 1;
    setLoading(false);
    setFailure(null);
  }, [selectionKey]);

  useEffect(() => {
    if (!enabled) {
      comparisonSequence.current += 1;
      setLoading(false);
      setFailure(null);
      setAvailabilityNotice("");
    }
  }, [enabled]);

  useEffect(
    () => () => {
      comparisonSequence.current += 1;
    },
    [],
  );

  const run = async (): Promise<void> => {
    if (!canRun) return;
    const requestId = ++comparisonSequence.current;
    setLoading(true);
    setFailure(null);
    setAvailabilityNotice("");
    const requestedKey = selectionKey;
    const identifiers = [...compareSelection];
    try {
      const [response, collectionsResponse] = await Promise.all([
        campaignTemplateDiscoveryApi.compare(identifiers),
        campaignTemplateDiscoveryApi.listCollections(),
      ]);
      if (
        requestId !== comparisonSequence.current ||
        requestedKey !== latestSelectionKey.current
      ) {
        return;
      }
      if (response.error) {
        setFailure(requestFailure(response.error));
        return;
      }
      const unavailable = new Set(
        response.data.unavailable_identifiers.map((identifier) =>
          identifier.toLocaleLowerCase(),
        ),
      );
      const availableSelection = identifiers.filter(
        (identifier) => !unavailable.has(identifier.toLocaleLowerCase()),
      );
      if (response.data.unavailable_identifiers.length) {
        const removed = response.data.unavailable_identifiers
          .map((identifier) => templateLabel(identifier, templates))
          .join(", ");
        setAvailabilityNotice(
          `${removed} ${response.data.unavailable_identifiers.length === 1 ? "is" : "are"} no longer available and ${response.data.unavailable_identifiers.length === 1 ? "was" : "were"} removed from this comparison.${availableSelection.length < 2 ? " Add another available template to continue." : ""}`,
        );
        onCompareSelectionChange(availableSelection);
      }
      setComparison(
        response.data.items.length >= 2 ? response.data.items : null,
      );
      setComparisonKey(availableSelection.join("\u0000"));
      if (collectionsResponse.error) {
        setCollectionMemberships(null);
      } else {
        const nextMemberships = new Map<string, string[]>();
        for (const collection of collectionsResponse.data.items) {
          for (const templateId of collection.template_ids) {
            const names = nextMemberships.get(templateId) ?? [];
            names.push(collection.name);
            nextMemberships.set(templateId, names);
          }
        }
        setCollectionMemberships(nextMemberships);
      }
    } catch {
      if (
        requestId === comparisonSequence.current &&
        requestedKey === latestSelectionKey.current
      ) {
        setFailure({
          message:
            "The comparison did not complete. Your selected templates are still in the tray.",
        });
      }
    } finally {
      if (
        requestId === comparisonSequence.current &&
        requestedKey === latestSelectionKey.current
      ) {
        setLoading(false);
      }
    }
  };

  const addPicked = (): void => {
    if (
      !pickerId ||
      compareSelection.includes(pickerId) ||
      compareSelection.length >= 4
    ) {
      return;
    }
    onCompareSelectionChange([...compareSelection, pickerId]);
    setPickerId("");
  };

  return (
    <section
      aria-labelledby="tpl-discovery-compare-heading"
      className="tpl-discovery-panel"
    >
      <div className="tpl-discovery-panel-heading">
        <div>
          <h3 id="tpl-discovery-compare-heading">Compare templates</h3>
          <p>
            Choose two to four templates. The server resolves every selected
            record before the table is shown.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!canRun}
          onClick={() => void run()}
        >
          {loading ? "Comparing…" : "Compare selected"}
        </button>
      </div>
      <div className="tpl-discovery-picker">
        <label htmlFor="tpl-compare-template-picker">
          Add from the loaded catalog
        </label>
        <div>
          <select
            id="tpl-compare-template-picker"
            value={pickerId}
            disabled={compareSelection.length >= 4}
            onChange={(event) => setPickerId(event.target.value)}
          >
            <option value="">Choose a template</option>
            {(rows ?? [])
              .filter((row) => !compareSelection.includes(row.id))
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!pickerId || compareSelection.length >= 4}
            onClick={addPicked}
          >
            Add
          </button>
        </div>
      </div>
      {compareSelection.length === 0 ? (
        <div className="empty-state">
          <h4>No templates selected</h4>
          <p>
            Use “Compare” on a catalog card or choose a loaded template above.
          </p>
        </div>
      ) : (
        <ol className="tpl-compare-selection" aria-label="Comparison selection">
          {compareSelection.map((id) => (
            <li key={id}>
              <span>{templateLabel(id, templates)}</span>
              <button
                type="button"
                className="btn btn-sm"
                aria-label={`Remove ${templateLabel(id, templates)} from comparison`}
                onClick={() =>
                  onCompareSelectionChange(
                    compareSelection.filter((candidate) => candidate !== id),
                  )
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}
      {compareSelection.length === 1 ? (
        <p className="tpl-discovery-guidance" role="status">
          Add one more template to compare.
        </p>
      ) : null}
      <FailureNotice
        failure={failure}
        loading={loading}
        onRetry={() => void run()}
      />
      {availabilityNotice ? (
        <div className="notice" role="status" aria-live="polite">
          {availabilityNotice}
        </div>
      ) : null}
      {resultsStale ? (
        <div className="notice" role="status">
          The selection changed. This is the previous verified comparison; run
          compare again to replace it.
        </div>
      ) : null}
      {comparison ? (
        <div
          className="tpl-compare-table-region"
          role="region"
          aria-label="Verified template comparison"
        >
          <table>
            <caption>
              Verified comparison of {comparison.length} templates
            </caption>
            <thead>
              <tr>
                <th scope="col">Template</th>
                <th scope="col">Goal</th>
                <th scope="col">Design</th>
                <th scope="col">Editing</th>
                <th scope="col">Preview</th>
                <th scope="col">Favorite</th>
                <th scope="col">Provenance</th>
                <th scope="col">Collections</th>
                <th scope="col">Ingestion quality</th>
                <th scope="col">Usage</th>
                <th scope="col">Updated</th>
                <th scope="col">Open</th>
              </tr>
            </thead>
            <tbody>
              {comparison.map((item) => (
                <tr key={item.requested_identifier}>
                  <th scope="row">
                    {item.template.name}
                    <small>
                      Matched by {item.matched_by} ·{" "}
                      {item.template.subject || "No subject"}
                    </small>
                  </th>
                  <td>{item.template.goal?.replaceAll("_", " ") || "None"}</td>
                  <td>
                    <span>Style: {item.template.style || "Not reported"}</span>
                    <small>
                      Layout: {item.template.layout || "Not reported"} ·
                      Industry: {item.template.industry || "Not reported"}
                    </small>
                  </td>
                  <td>{templateEditingAvailability(item.template)}</td>
                  <td>
                    <span>
                      Desktop:{" "}
                      {templatePreviewAvailability(item.template, "desktop")}
                    </span>
                    <small>
                      Mobile:{" "}
                      {templatePreviewAvailability(item.template, "mobile")}
                    </small>
                  </td>
                  <td>{templateFavoriteState(item.template)}</td>
                  <td>
                    {templateProvenance(item.template)}
                    {item.template.source_license_status ? (
                      <small>
                        License: {item.template.source_license_status}
                      </small>
                    ) : null}
                  </td>
                  <td>
                    {collectionMemberships === null
                      ? "Unavailable"
                      : (collectionMemberships.get(item.template.id)?.join(
                          " · ",
                        ) ?? "None")}
                  </td>
                  <td>{reviewLabel(item.template)}</td>
                  <td>{(item.template.usage_count ?? 0).toLocaleString()}</td>
                  <td>
                    {item.template.updated_at
                      ? readableDate(item.template.updated_at)
                      : "Not recorded"}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => onOpenTemplate(item.template)}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
