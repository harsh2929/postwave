/**
 * BlockEditor — coverage item #1 (email_blocks), the flagship of the
 * full-surface wiring pass.
 *
 * Loads the block catalog (GET /email-blocks/catalog → tenant brand
 * defaults + block specs), lets the operator build an ordered list of
 * block instances (add from the catalog, remove, reorder, edit each
 * block's fields per its catalog spec), and composes the list into
 * MJML via POST /email-blocks/compose. The composed MJML feeds the
 * existing `renderEmailPreview` pipeline (EmailPreviewTabs) for a
 * live multi-client preview; compose warnings surface in a Notice.
 *
 * State ownership: the parent (CampaignDetailSlideover) owns the
 * instance list so the structure survives Blocks ↔ HTML mode flips
 * within an editing session. This component owns only the catalog,
 * the compose result, and which row is expanded.
 *
 * Honest-UI: catalog failure → error + Retry (no fake catalog);
 * compose failure → inline error + Retry while the last good compose
 * stays on screen for the preview.
 */

import { type ReactElement, useEffect, useRef, useState } from "react";

import {
  type EmailBlockCatalogResponse,
  type EmailBlock,
  type EmailBlockFieldSpec,
  type EmailBlockInstance,
  emailBlocksApi,
  getWorkspaceSettings,
} from "../../lib/api-client";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { EmailPreviewTabs } from "../EmailPreviewTabs";
import { Icon } from "../Icon";
import { Notice } from "../Notice";
import { Skeleton } from "../Skeleton";
import {
  addInstance,
  buildComposeInput,
  coerceFieldValue,
  fieldValueAsString,
  groupBlocksByCategory,
  indexBlocks,
  instanceSummary,
  moveInstance,
  removeInstanceAt,
  setInstanceField,
} from "./block-editor-helpers";

const COMPOSE_DEBOUNCE_MS = 600;

interface Props {
  /** Ordered block instances — state owned by the parent so the
   *  structure persists across Blocks/HTML mode flips. */
  instances: EmailBlockInstance[];
  onInstancesChange: (next: EmailBlockInstance[]) => void;
  /** Campaign subject — threaded into compose for blocks that use it. */
  subject?: string;
  /** Fired on every successful compose with the fresh MJML, so the
   *  parent can keep "last composed output" for the HTML mode flip. */
  onComposed?: (mjml: string) => void;
  /** Fired when the operator clicks "Apply to body". */
  onApply: (mjml: string) => void;
  /** Viewer-role gate for the Apply button. */
  canMutate: boolean;
}

export function BlockEditor({
  instances,
  onInstancesChange,
  subject,
  onComposed,
  onApply,
  canMutate,
}: Props): ReactElement {
  const [catalog, setCatalog] = useState<EmailBlockCatalogResponse | null>(
    null,
  );
  const [catalogErr, setCatalogErr] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  // GAP-3#7: the catalog's brand block is a hardcoded server placeholder
  // (#1d4ed8 / Helvetica), NOT the tenant's brand. Load the real workspace
  // brand_color and merge it into the compose brand so blocks-composed emails
  // actually use the tenant's colour (falls back to the placeholder when the
  // workspace has no brand_color set or the settings route is unavailable).
  const [brandColor, setBrandColor] = useState<string | null>(null);

  const [addId, setAddId] = useState<string>("");
  const [expanded, setExpanded] = useState<number | null>(null);

  const [mjml, setMjml] = useState<string>("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [composeErr, setComposeErr] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  // GAP-3#6: true when the instance list / subject changed since the last
  // SUCCESSFUL compose, so the current `mjml` is stale. Apply is disabled
  // while dirty to stop it persisting a pre-edit body during the compose
  // debounce window or after a failed compose.
  const [dirty, setDirty] = useState(false);
  /** Guards against stale compose responses clobbering newer ones. */
  const composeSeq = useRef(0);
  const catalogSeq = useRef(0);
  const debounceRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      catalogSeq.current += 1;
      composeSeq.current += 1;
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, []);

  useBlockEditorLifecycle(dirty, composing);

  const loadCatalog = async (): Promise<void> => {
    const requestId = ++catalogSeq.current;
    setCatalogLoading(true);
    setCatalogErr(null);
    try {
      const res = await emailBlocksApi.catalog();
      if (!mountedRef.current || requestId !== catalogSeq.current) return;
      if (res.error) {
        setCatalogErr(res.error.message);
        return;
      }
      setCatalog(res.data);
      setAddId((current) => current || res.data.blocks[0]?.id || "");
    } catch {
      if (mountedRef.current && requestId === catalogSeq.current) {
        setCatalogErr("The block catalog request did not complete.");
      }
    } finally {
      if (mountedRef.current && requestId === catalogSeq.current) {
        setCatalogLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadCatalog();
    // GAP-3#7: pull the tenant's real brand colour (best-effort — an older
    // self-hosted API without the settings route just leaves the placeholder).
    void (async (): Promise<void> => {
      try {
        const res = await getWorkspaceSettings();
        if (mountedRef.current && !res.error && res.data.brand_color?.trim()) {
          setBrandColor(res.data.brand_color.trim());
        }
      } catch {
        // Brand enrichment is best-effort; catalog defaults remain usable.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const compose = async (): Promise<void> => {
    if (!catalog) return;
    if (instances.length === 0) {
      // Invalidate any in-flight compose so a stale response can't
      // overwrite the cleared state below.
      composeSeq.current++;
      setMjml("");
      setWarnings([]);
      setComposeErr(null);
      setComposing(false);
      setDirty(false); // GAP-3#6: nothing to apply, so not "stale"
      return;
    }
    const seq = ++composeSeq.current;
    setComposing(true);
    // GAP-3#7: override the placeholder primary colour with the real
    // workspace brand colour when we have one.
    const brand = brandColor
      ? { ...catalog.brand, primary_color: brandColor }
      : catalog.brand;
    try {
      const res = await emailBlocksApi.compose(
        buildComposeInput(brand, instances, subject),
      );
      if (!mountedRef.current || seq !== composeSeq.current) return;
      if (res.error) {
        setComposeErr(res.error.message);
        return;
      }
      setComposeErr(null);
      setMjml(res.data.mjml);
      setWarnings(res.data.warnings ?? []);
      setDirty(false);
      onComposed?.(res.data.mjml);
    } catch {
      if (mountedRef.current && seq === composeSeq.current) {
        setComposeErr("The block compose request did not complete.");
      }
    } finally {
      if (mountedRef.current && seq === composeSeq.current) {
        setComposing(false);
      }
    }
  };

  // Debounced auto-compose whenever the structure (or catalog) changes.
  useEffect(() => {
    if (!catalog) return;
    // GAP-3#6: the current mjml no longer reflects these instances until the
    // (debounced) compose below finishes — mark dirty so Apply is disabled in
    // the meantime.
    setDirty(true);
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void compose();
    }, COMPOSE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instances, catalog, subject]);

  /* ------- catalog loading / error states --------------------------- */

  if (catalogLoading) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <Skeleton lines={3} aria-label="Loading block catalog" />
        <div className="muted" style={{ fontSize: 12 }}>
          Loading block catalog…
        </div>
      </div>
    );
  }

  if (catalogErr || !catalog) {
    return (
      <Notice
        tone="danger"
        title="Couldn't load the block catalog"
        action={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void loadCatalog()}
          >
            Retry
          </button>
        }
      >
        {catalogErr ?? "Unknown error"}
      </Notice>
    );
  }

  const blockIndex = indexBlocks(catalog.blocks);
  const groups = groupBlocksByCategory(catalog.blocks);

  const addSelected = (): void => {
    const block = blockIndex.get(addId);
    if (!block) return;
    onInstancesChange(addInstance(instances, block));
    setExpanded(instances.length); // expand the freshly added row
  };

  // GAP-3#15: reorder a row AND keep `expanded` (a positional index) pointing
  // at the SAME block. moveInstance swaps rows i and i+delta, so remap the
  // open index across the swap; otherwise the expanded editor flips to the
  // neighbouring block's fields after a move.
  const moveRow = (i: number, delta: 1 | -1): void => {
    onInstancesChange(moveInstance(instances, i, delta));
    const j = i + delta;
    if (j < 0 || j >= instances.length) return; // boundary no-op
    setExpanded((cur) => {
      if (cur === null) return cur;
      if (cur === i) return j;
      if (cur === j) return i;
      return cur;
    });
  };

  // GAP-3#7: the tenant's real brand colour when configured, else the
  // catalog placeholder — used for the empty-state hint and compose.
  const brandPrimary = brandColor ?? catalog.brand.primary_color;
  const applyDisabledReason = blockApplyDisabledReason({
    canMutate,
    composeErr,
    composing,
    dirty,
    instanceCount: instances.length,
    mjml,
  });

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <BlockCatalogPicker
        addId={addId}
        blockIndex={blockIndex}
        groups={groups}
        onAdd={addSelected}
        onSelect={setAddId}
      />

      {/* Instance list */}
      {instances.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No blocks yet — pick one from the catalog above to start building.
          Brand defaults ({catalog.brand.body_font}, {brandPrimary}) apply
          automatically.
        </div>
      ) : (
        <BlockInstanceList
          blockIndex={blockIndex}
          expanded={expanded}
          instances={instances}
          onFieldChange={(index, key, value) =>
            onInstancesChange(setInstanceField(instances, index, key, value))
          }
          onMove={moveRow}
          onRemove={(index) => {
            onInstancesChange(removeInstanceAt(instances, index));
            setExpanded(null);
          }}
          onToggle={(index) =>
            setExpanded((current) => (current === index ? null : index))
          }
        />
      )}

      {/* Compose status / warnings */}
      {composeErr ? (
        <Notice
          tone="danger"
          title="Compose failed"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void compose()}
            >
              Retry
            </button>
          }
        >
          {composeErr}
        </Notice>
      ) : null}
      {warnings.length > 0 ? (
        <Notice tone="warning" title="Compose warnings">
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {warnings.map((w, i) => (
              <li key={`${i}-${w}`}>{w}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {/* Apply */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {applyDisabledReason ? (
          <span
            id="block-editor-apply-reason"
            className="muted"
            role={composing ? "status" : undefined}
            style={{ fontSize: 11 }}
          >
            {applyDisabledReason}
          </span>
        ) : null}
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => onApply(mjml)}
          disabled={applyDisabledReason !== null}
          aria-describedby={
            applyDisabledReason ? "block-editor-apply-reason" : undefined
          }
        >
          Apply to body
        </button>
      </div>

      {/* Live preview through the existing render pipeline */}
      {mjml !== "" ? (
        <div>
          <div className="label">Live preview</div>
          <EmailPreviewTabs body={mjml} />
        </div>
      ) : null}
    </div>
  );
}

function useBlockEditorLifecycle(dirty: boolean, composing: boolean): void {
  useEffect(() => {
    if (!dirty && !composing) return;
    return registerLifecycleGuard({
      id: "campaign-block-editor",
      label: "Campaign block editor",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : composing
            ? {
                level: "blocking",
                detail:
                  "The latest campaign block changes are still composing.",
              }
            : {
                level: "warning",
                detail:
                  "Campaign block changes have not yet produced an up-to-date body preview.",
              },
    });
  }, [composing, dirty]);
}

function blockApplyDisabledReason({
  canMutate,
  composeErr,
  composing,
  dirty,
  instanceCount,
  mjml,
}: {
  canMutate: boolean;
  composeErr: string | null;
  composing: boolean;
  dirty: boolean;
  instanceCount: number;
  mjml: string;
}): string | null {
  if (!canMutate) return "Viewer role can't edit the draft.";
  if (instanceCount === 0) return "Add at least one block first.";
  if (composeErr) return "Resolve the compose error before applying.";
  if (composing || dirty) return "Wait for the preview to finish composing.";
  if (!mjml) return "Compose a current preview before applying.";
  return null;
}

function BlockCatalogPicker({
  addId,
  blockIndex,
  groups,
  onAdd,
  onSelect,
}: {
  addId: string;
  blockIndex: Map<string, EmailBlock>;
  groups: ReturnType<typeof groupBlocksByCategory>;
  onAdd: () => void;
  onSelect: (id: string) => void;
}): ReactElement {
  const selected = blockIndex.get(addId);
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select
          className="input"
          aria-label="Block to add"
          aria-describedby={selected ? "block-to-add-description" : undefined}
          value={addId}
          onChange={(event) => onSelect(event.target.value)}
          style={{ flex: 1 }}
        >
          {groups.map((group) => (
            <optgroup key={group.category} label={group.category}>
              {group.blocks.map((block) => (
                <option key={block.id} value={block.id}>
                  {block.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onAdd}
          disabled={!addId}
        >
          Add block
        </button>
      </div>
      {selected ? (
        <div
          id="block-to-add-description"
          className="field-help"
          style={{ marginTop: 4 }}
        >
          {selected.description}
        </div>
      ) : null}
    </div>
  );
}

interface BlockInstanceListProps {
  blockIndex: Map<string, EmailBlock>;
  expanded: number | null;
  instances: EmailBlockInstance[];
  onFieldChange: (index: number, key: string, value: unknown) => void;
  onMove: (index: number, delta: 1 | -1) => void;
  onRemove: (index: number) => void;
  onToggle: (index: number) => void;
}

function BlockInstanceList({
  blockIndex,
  expanded,
  instances,
  onFieldChange,
  onMove,
  onRemove,
  onToggle,
}: BlockInstanceListProps): ReactElement {
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {instances.map((instance, index) => (
        <BlockInstanceRow
          key={instance.block_id + "-" + index}
          block={blockIndex.get(instance.block_id)}
          index={index}
          instance={instance}
          isOpen={expanded === index}
          itemCount={instances.length}
          onFieldChange={onFieldChange}
          onMove={onMove}
          onRemove={onRemove}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function BlockInstanceRow({
  block,
  index,
  instance,
  isOpen,
  itemCount,
  onFieldChange,
  onMove,
  onRemove,
  onToggle,
}: Omit<BlockInstanceListProps, "blockIndex" | "expanded" | "instances"> & {
  block: EmailBlock | undefined;
  index: number;
  instance: EmailBlockInstance;
  isOpen: boolean;
  itemCount: number;
}): ReactElement {
  const name = block?.name ?? instance.block_id;
  const panelId = "block-editor-fields-" + index;
  return (
    <div
      style={{
        borderTop: index > 0 ? "1px solid var(--pw-border)" : undefined,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: "6px 8px",
        }}
      >
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onToggle(index)}
          aria-expanded={isOpen}
          aria-controls={panelId}
          aria-label={(isOpen ? "Collapse" : "Edit") + " fields for " + name}
          style={{ minWidth: 28 }}
        >
          <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={12} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 12 }}>{name}</div>
          <div
            className="muted"
            style={{
              fontSize: 11,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {instanceSummary(block, instance)}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onMove(index, -1)}
          disabled={index === 0}
          aria-label={"Move " + name + " up"}
        >
          <Icon name="chevron-up" size={12} />
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onMove(index, 1)}
          disabled={index === itemCount - 1}
          aria-label={"Move " + name + " down"}
        >
          <Icon name="chevron-down" size={12} />
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={() => onRemove(index)}
          aria-label={"Remove " + name}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div
        id={panelId}
        hidden={!isOpen}
        style={{ padding: "4px 10px 10px 44px" }}
      >
        <div style={{ display: "grid", gap: 8 }}>
          {block == null ? (
            <div className="muted" style={{ fontSize: 11 }}>
              This block is no longer in the catalog; its saved config still
              composes server-side.
            </div>
          ) : block.fields.length === 0 ? (
            <div className="muted" style={{ fontSize: 11 }}>
              This block has no editable fields.
            </div>
          ) : (
            block.fields.map((field) => (
              <BlockFieldInput
                key={field.key}
                field={field}
                value={instance.config[field.key]}
                inputId={"blk-" + index + "-" + field.key}
                onChange={(value) => onFieldChange(index, field.key, value)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ------- per-field input ---------------------------------------------- */

function BlockFieldInput({
  field,
  value,
  inputId,
  onChange,
}: {
  field: EmailBlockFieldSpec;
  value: unknown;
  inputId: string;
  onChange: (value: unknown) => void;
}): ReactElement {
  const strValue = fieldValueAsString(value);

  if (field.type === "bool") {
    return (
      <label
        htmlFor={inputId}
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        <input
          id={inputId}
          type="checkbox"
          checked={value === true || value === "true"}
          onChange={(e) => onChange(coerceFieldValue(field, e.target.checked))}
        />
        <span>{field.label}</span>
        {field.help ? (
          <span className="muted" style={{ fontSize: 11 }}>
            {field.help}
          </span>
        ) : null}
      </label>
    );
  }

  if (field.type === "select") {
    return (
      <div className="field" style={{ margin: 0 }}>
        <label
          className="field-label"
          htmlFor={inputId}
          style={{ fontSize: 11 }}
        >
          {field.label}
        </label>
        <select
          id={inputId}
          className="input"
          value={strValue}
          onChange={(e) => onChange(coerceFieldValue(field, e.target.value))}
        >
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        {field.help ? <div className="field-help">{field.help}</div> : null}
      </div>
    );
  }

  if (field.type === "textarea") {
    return (
      <div className="field" style={{ margin: 0 }}>
        <label
          className="field-label"
          htmlFor={inputId}
          style={{ fontSize: 11 }}
        >
          {field.label}
        </label>
        <textarea
          id={inputId}
          className="input"
          rows={3}
          value={strValue}
          onChange={(e) => onChange(coerceFieldValue(field, e.target.value))}
        />
        {field.help ? <div className="field-help">{field.help}</div> : null}
      </div>
    );
  }

  // text / url / image_url / color / number — all text-ish inputs.
  return (
    <div className="field" style={{ margin: 0 }}>
      <label className="field-label" htmlFor={inputId} style={{ fontSize: 11 }}>
        {field.label}
        {field.type === "color" ? (
          <span className="muted" style={{ marginLeft: 6, fontSize: 10 }}>
            (CSS color)
          </span>
        ) : null}
      </label>
      <input
        id={inputId}
        type={field.type === "number" ? "number" : "text"}
        className="input"
        value={strValue}
        inputMode={field.type === "number" ? "decimal" : undefined}
        onChange={(e) => onChange(coerceFieldValue(field, e.target.value))}
      />
      {field.help ? <div className="field-help">{field.help}</div> : null}
    </div>
  );
}
