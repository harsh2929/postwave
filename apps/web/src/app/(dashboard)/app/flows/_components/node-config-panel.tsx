// SPDX-License-Identifier: AGPL-3.0-only
//
// Right-rail editor for the selected flow node. Renders the node's catalog
// fields as typed inputs and exposes its outgoing connection(s): a single
// "Next step" for linear nodes, or labelled true/false legs for a branch.
// Connection dropdowns show human labels (FLOW-015); condition fields carry
// help text (FLOW-043); deleting a configured node confirms first (FLOW-026);
// controls use the shared Select / IconButton primitives (FLOW-044).
"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useId } from "react";

import {
  type CatalogItem,
  type ConditionFieldSpec,
  type FieldSpec,
  type FlowNode,
} from "@/lib/flows-api";
import { nodeOptionLabel } from "@/lib/flow-graph";
import { EntityPicker, PICKABLE_FIELDS } from "./entity-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { asRoute } from "@/lib/typed-routes";

const COMPARATORS = [
  "eq",
  "neq",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
];

// FLOW-043: what each predictive / RFM condition field means and its range.
const FIELD_HELP: Record<string, string> = {
  "custom.predicted_churn_risk":
    "Model estimate 0–1 that the subscriber will lapse. Higher = more at risk.",
  "custom.predicted_clv_cents":
    "Predicted lifetime value, in cents (e.g. 50000 = $500).",
  "custom.predicted_order_count": "Predicted number of future orders.",
  "custom.predicted_next_order_at":
    "Expected date of the subscriber's next order.",
  "custom.predicted_gender": "Predicted gender label.",
  "custom.rfm_segment": "RFM segment label (e.g. Champions, At risk).",
  "custom.rfm_score": "Combined RFM score.",
  "custom.rfm_recency": "Recency score, 1 (long ago) to 5 (recent).",
  "custom.rfm_frequency": "Frequency score, 1 (rare) to 5 (frequent).",
  "custom.rfm_monetary": "Monetary score, 1 (low spend) to 5 (high spend).",
};

const AB_METRICS = [
  { key: "opens", label: "Opens" },
  { key: "clicks", label: "Clicks" },
  { key: "conversions", label: "Conversions" },
  { key: "revenue", label: "Revenue" },
];

interface NodeConfigPanelProps {
  node: FlowNode;
  nodes: FlowNode[];
  nodeCatalog: CatalogItem[];
  triggerCatalog?: CatalogItem[];
  conditionFields: ConditionFieldSpec[];
  currentNext: string;
  isEntry: boolean;
  inboundCount: number;
  requiresReview: boolean;
  readOnly?: boolean;
  onChange: (patch: Partial<FlowNode>) => void;
  onSetNext: (toId: string) => void;
  onMakeEntry: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function NodeConfigPanel({
  node,
  nodes,
  nodeCatalog,
  triggerCatalog = [],
  conditionFields,
  currentNext,
  isEntry,
  inboundCount,
  requiresReview,
  readOnly = false,
  onChange,
  onSetNext,
  onMakeEntry,
  onDelete,
  onClose,
}: NodeConfigPanelProps) {
  const meta = nodeCatalog.find((c) => c.key === node.type);
  const others = nodes.filter((n) => n.id !== node.id);
  const fields = (meta?.fields ?? []).filter(
    (f) =>
      f.key !== "condition" &&
      f.key !== "goal" &&
      !f.key.includes(".") &&
      f.type !== "array" &&
      f.type !== "trigger" &&
      f.type !== "segment_condition",
  );

  const isConfigured = Object.keys(node).some(
    (k) => !["id", "type", "position"].includes(k),
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto px-4 pb-20 pt-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {meta?.label ?? node.type}
          </p>
          <p className="break-all text-xs text-muted-foreground">{node.id}</p>
          {requiresReview ? (
            <Badge variant="warning" className="mt-1">
              Requires review
            </Badge>
          ) : null}
        </div>
        <IconButton
          size="sm"
          aria-label="Close panel"
          onClick={onClose}
          className="text-muted-foreground"
        >
          <span aria-hidden className="text-sm">
            ✕
          </span>
        </IconButton>
      </div>

      {readOnly ? (
        <p
          role="note"
          className="rounded-md border border-warning/40 bg-warning-subtle p-2 text-xs text-warning-emphasis"
        >
          This node is read-only for your current flow access. You can inspect
          its saved settings and linked records.
        </p>
      ) : null}

      <fieldset disabled={readOnly} className="contents">
        {fields.map((field) => (
          <FieldEditor
            key={field.key}
            field={field}
            value={node[field.key]}
            onChange={(v) => onChange({ [field.key]: v })}
            crossLink={crossLinkFor(field.key, node[field.key])}
          />
        ))}

        {node.type === "branch" ? (
          <ConditionEditor
            label="Condition"
            condition={(node.condition as Record<string, unknown>) ?? {}}
            conditionFields={conditionFields}
            onChange={(condition) => onChange({ condition })}
          />
        ) : null}

        {node.type === "goal" ? (
          <ConditionEditor
            label="Goal condition"
            condition={(node.goal as Record<string, unknown>) ?? {}}
            conditionFields={conditionFields}
            onChange={(goal) => onChange({ goal })}
          />
        ) : null}

        {node.type === "action" ? (
          <ActionEditor
            aria-label="Flow action configuration"
            action={(node.action as Record<string, unknown>) ?? {}}
            onChange={(action) => onChange({ action })}
          />
        ) : null}

        {node.type === "wait_until_trigger" ? (
          <WaitTriggerEditor
            trigger={(node.wait_trigger as Record<string, unknown>) ?? {}}
            triggerCatalog={triggerCatalog}
            onChange={(wait_trigger) => onChange({ wait_trigger })}
          />
        ) : null}

        {node.type === "coupon_assign" ? (
          <div className="space-y-1">
            <Label className="text-xs">Coupon pool</Label>
            <EntityPicker
              entity="coupon"
              aria-label="coupon_pool_id"
              value={
                typeof (node.metadata as Record<string, unknown> | undefined)
                  ?.coupon_pool_id === "string"
                  ? String(
                      (node.metadata as Record<string, unknown>).coupon_pool_id,
                    )
                  : ""
              }
              onChange={(coupon_pool_id) =>
                onChange({
                  metadata: {
                    ...((node.metadata as Record<string, unknown>) ?? {}),
                    coupon_pool_id,
                  },
                })
              }
            />
          </div>
        ) : null}

        {node.type === "ab_test" ? (
          <ABTestSettings node={node} onChange={onChange} />
        ) : null}

        {node.type === "percentage_split" || node.type === "ab_test" ? (
          <VariantsEditor
            variants={
              Array.isArray(node.variants)
                ? (node.variants as Array<Record<string, unknown>>)
                : []
            }
            options={others}
            nodeCatalog={nodeCatalog}
            conditionFields={conditionFields}
            onChange={(variants) => onChange({ variants })}
          />
        ) : null}

        {/* Connections */}
        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Connections
          </p>
          {node.type === "branch" ? (
            <>
              <ConnectionSelect
                label="If condition matches → "
                value={typeof node.true_next === "string" ? node.true_next : ""}
                options={others}
                nodeCatalog={nodeCatalog}
                conditionFields={conditionFields}
                onChange={(v) => onChange({ true_next: v })}
              />
              <ConnectionSelect
                label="Otherwise → "
                value={
                  typeof node.false_next === "string" ? node.false_next : ""
                }
                options={others}
                nodeCatalog={nodeCatalog}
                conditionFields={conditionFields}
                onChange={(v) => onChange({ false_next: v })}
              />
            </>
          ) : node.type === "percentage_split" || node.type === "ab_test" ? (
            <p className="text-xs text-muted-foreground">
              Routing is defined per-variant above.
            </p>
          ) : (
            <ConnectionSelect
              label="Next step"
              value={currentNext}
              options={others}
              nodeCatalog={nodeCatalog}
              conditionFields={conditionFields}
              onChange={onSetNext}
            />
          )}
        </div>

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onMakeEntry}
            disabled={isEntry}
          >
            {isEntry ? "Entry step" : "Set as entry"}
          </Button>
          {isConfigured || inboundCount > 0 ? (
            <ConfirmDialog
              trigger={
                <Button type="button" variant="destructive" size="sm">
                  Delete step
                </Button>
              }
              title="Delete this step?"
              description={deleteDescription(inboundCount)}
              confirmLabel="Delete step"
              confirmVariant="destructive"
              onConfirm={onDelete}
            />
          ) : (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={onDelete}
            >
              Delete step
            </Button>
          )}
        </div>
      </fieldset>
    </div>
  );
}

function deleteDescription(inboundCount: number): string {
  const base =
    "This removes the step and its configuration. You can undo immediately after.";
  if (inboundCount > 0) {
    return `${base} ${inboundCount} incoming connection${
      inboundCount === 1 ? "" : "s"
    } will be severed.`;
  }
  return base;
}

/** FLOW-029: a cross-link to the referenced entity's detail page, where one
 *  exists. Kept conservative — only fields with a known detail route. */
function crossLinkFor(
  key: string,
  value: unknown,
): { href: string; label: string } | null {
  if (typeof value !== "string" || !value) return null;
  // Encoded, like flow-journey-preview does for the same template id. These
  // normally come from a picker, but a graph authored through the API or by an
  // agent can carry any string, and an unescaped "?", "#" or "../" would
  // rewrite the destination rather than land on the record.
  const id = encodeURIComponent(value);
  if (key === "template_id") {
    return { href: `/app/templates/${id}`, label: "Open template" };
  }
  if (key === "campaign_id") {
    return { href: `/app/campaigns/${id}`, label: "Open campaign" };
  }
  // FLOW-029: branches/triggers reference segments; actions move to lists.
  if (key === "segment_id") {
    return {
      href: `/app/subscribers/segments/${id}`,
      label: "Open segment",
    };
  }
  if (key === "list_id") {
    // No dedicated /app/lists/[id] page — jump to the members view instead.
    return {
      href: `/app/subscribers?list=${id}`,
      label: "View list members",
    };
  }
  return null;
}

function ConnectionSelect({
  label,
  value,
  options,
  nodeCatalog,
  conditionFields,
  onChange,
}: {
  label: string;
  value: string;
  options: FlowNode[];
  nodeCatalog: CatalogItem[];
  conditionFields: ConditionFieldSpec[];
  onChange: (v: string) => void;
}) {
  const selectId = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={selectId} className="text-xs">
        {label}
      </Label>
      <Select
        id={selectId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">— End of flow —</option>
        {options.map((n) => (
          <option key={n.id} value={n.id}>
            {nodeOptionLabel(n, nodeCatalog, { conditionFields })}
          </option>
        ))}
      </Select>
    </div>
  );
}

function FieldEditor({
  field,
  value,
  onChange,
  crossLink,
}: {
  field: FieldSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  crossLink?: { href: string; label: string } | null;
}) {
  const labelText = `${humanizeKey(field.key)}${field.required ? " *" : ""}`;
  const strValue = value == null ? "" : String(value);
  const fieldId = useId();

  // FLOW-009: pickable entity fields get a name-resolving searchable Select.
  const pickerEntity = PICKABLE_FIELDS[field.key];
  if (pickerEntity) {
    return (
      <div className="space-y-1">
        <Label className="text-xs">{labelText}</Label>
        <EntityPicker
          entity={pickerEntity}
          value={strValue}
          onChange={(v) => onChange(v)}
          aria-label={field.key}
        />
        {crossLink ? (
          <Link
            href={asRoute(crossLink.href)}
            className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="h-3 w-3" />
            {crossLink.label}
          </Link>
        ) : null}
      </div>
    );
  }

  const linkRow = crossLink ? (
    <Link
      href={asRoute(crossLink.href)}
      className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      <ExternalLink className="h-3 w-3" />
      {crossLink.label}
    </Link>
  ) : null;

  if (field.type === "textarea") {
    return (
      <div className="space-y-1">
        <Label htmlFor={fieldId} className="text-xs">
          {labelText}
        </Label>
        <Textarea
          id={fieldId}
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
        />
        {linkRow}
      </div>
    );
  }
  if (field.type === "select" && field.options?.length) {
    return (
      <div className="space-y-1">
        <Label htmlFor={fieldId} className="text-xs">
          {labelText}
        </Label>
        <Select
          id={fieldId}
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">— Select —</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      </div>
    );
  }
  if (field.type === "number") {
    return (
      <div className="space-y-1">
        <Label htmlFor={fieldId} className="text-xs">
          {labelText}
        </Label>
        <Input
          id={fieldId}
          type="number"
          value={strValue}
          onChange={(e) =>
            onChange(e.target.value === "" ? undefined : Number(e.target.value))
          }
        />
        {linkRow}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <Label htmlFor={fieldId} className="text-xs">
        {labelText}
      </Label>
      <Input
        id={fieldId}
        type={field.type === "datetime" ? "datetime-local" : "text"}
        value={strValue}
        onChange={(e) => onChange(e.target.value)}
      />
      {linkRow}
    </div>
  );
}

function WaitTriggerEditor({
  trigger,
  triggerCatalog,
  onChange,
}: {
  trigger: Record<string, unknown>;
  triggerCatalog: CatalogItem[];
  onChange: (trigger: Record<string, unknown>) => void;
}) {
  const type = typeof trigger.type === "string" ? trigger.type : "";
  const meta = triggerCatalog.find((item) => item.key === type);
  const triggerTypeId = useId();
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs font-semibold text-foreground">Event to wait for</p>
      <div className="space-y-1">
        <Label htmlFor={triggerTypeId} className="text-xs">
          Trigger type *
        </Label>
        <Select
          id={triggerTypeId}
          value={type}
          onChange={(event) => onChange({ type: event.target.value })}
        >
          <option value="">— Select event —</option>
          {triggerCatalog.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </Select>
      </div>
      {(meta?.fields ?? []).map((field) => (
        <FieldEditor
          key={field.key}
          field={field}
          value={trigger[field.key]}
          crossLink={crossLinkFor(field.key, trigger[field.key])}
          onChange={(value) => onChange({ ...trigger, [field.key]: value })}
        />
      ))}
    </div>
  );
}

function ConditionEditor({
  label = "Condition",
  condition,
  conditionFields,
  onChange,
}: {
  label?: string;
  condition: Record<string, unknown>;
  conditionFields: ConditionFieldSpec[];
  onChange: (c: Record<string, unknown>) => void;
}) {
  const field = typeof condition.field === "string" ? condition.field : "";
  const comparator =
    typeof condition.comparator === "string" ? condition.comparator : "eq";
  const value = condition.value == null ? "" : String(condition.value);
  const help = FIELD_HELP[field];
  const fieldId = useId();
  const comparatorId = useId();
  const valueId = useId();

  const set = (patch: Record<string, unknown>) =>
    onChange({
      op: "condition",
      field,
      comparator,
      value,
      ...condition,
      ...patch,
    });

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs font-semibold text-foreground">{label}</p>
      <div className="space-y-1">
        <Label htmlFor={fieldId} className="text-xs">
          Field
        </Label>
        <Select
          id={fieldId}
          value={field}
          onChange={(e) => set({ field: e.target.value })}
        >
          <option value="">— Select field —</option>
          {conditionFields.map((cf) => (
            <option key={cf.key} value={cf.key}>
              {cf.label} ({cf.category})
            </option>
          ))}
        </Select>
        {help ? (
          <p className="text-[11px] text-muted-foreground">{help}</p>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={comparatorId} className="text-xs">
            Operator
          </Label>
          <Select
            id={comparatorId}
            value={comparator}
            onChange={(e) => set({ comparator: e.target.value })}
          >
            {COMPARATORS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={valueId} className="text-xs">
            Value
          </Label>
          <Input
            id={valueId}
            value={value}
            onChange={(e) => set({ value: e.target.value })}
            disabled={comparator === "exists"}
          />
        </div>
      </div>
    </div>
  );
}

const ACTION_KINDS = [
  { key: "add_tag", label: "Add tag" },
  { key: "remove_tag", label: "Remove tag" },
  { key: "move_to_list", label: "Move to list" },
  { key: "unsubscribe", label: "Unsubscribe" },
  { key: "update_profile_property", label: "Update profile property" },
  { key: "flow_webhook", label: "Send webhook" },
];

function ActionEditor({
  "aria-label": ariaLabel,
  action,
  onChange,
}: {
  "aria-label": string;
  action: Record<string, unknown>;
  onChange: (a: Record<string, unknown>) => void;
}) {
  const kind = typeof action.kind === "string" ? action.kind : "";
  const set = (patch: Record<string, unknown>) =>
    onChange({ ...action, ...patch });
  const strOf = (k: string) => (action[k] == null ? "" : String(action[k]));
  const kindId = useId();

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="space-y-2 rounded-md border border-border bg-muted/30 p-3"
    >
      <p className="text-xs font-semibold text-foreground">Action</p>
      <div className="space-y-1">
        <Label htmlFor={kindId} className="text-xs">
          Kind
        </Label>
        <Select
          id={kindId}
          value={kind}
          onChange={(e) => set({ kind: e.target.value })}
        >
          <option value="">— Select —</option>
          {ACTION_KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </Select>
      </div>
      {kind === "add_tag" || kind === "remove_tag" ? (
        <LabeledInput
          label="Tag"
          value={strOf("tag")}
          onChange={(v) => set({ tag: v })}
        />
      ) : null}
      {kind === "move_to_list" ? (
        <div className="space-y-1">
          <Label className="text-xs">Target list</Label>
          <EntityPicker
            entity="list"
            aria-label="list_id"
            value={strOf("list_id")}
            onChange={(v) => set({ list_id: v })}
          />
          {/* FLOW-029: jump to the referenced list's members. */}
          {crossLinkFor("list_id", strOf("list_id")) ? (
            <Link
              href={asRoute(crossLinkFor("list_id", strOf("list_id"))!.href)}
              className="inline-block text-xs text-primary underline-offset-2 hover:underline"
            >
              {crossLinkFor("list_id", strOf("list_id"))!.label}
            </Link>
          ) : null}
        </div>
      ) : null}
      {kind === "update_profile_property" ? (
        <>
          <LabeledInput
            label="Property field"
            value={strOf("field")}
            onChange={(v) => set({ field: v })}
          />
          <LabeledInput
            label="Value"
            value={strOf("value")}
            onChange={(v) => set({ value: v })}
          />
        </>
      ) : null}
      {kind === "flow_webhook" ? (
        <LabeledInput
          label="Webhook URL"
          value={strOf("url")}
          onChange={(v) => set({ url: v })}
        />
      ) : null}
    </div>
  );
}

/**
 * FLOW-030: A/B-test-specific settings beyond a bare percentage split — a
 * success metric, an evaluation window, and a retained auto-promote preference.
 * These values round-trip as configuration only. Winner evaluation and
 * promotion are release-held, so the effectful preference remains read-only
 * and the UI must not imply that saving it schedules execution.
 */
function ABTestSettings({
  node,
  onChange,
}: {
  node: FlowNode;
  onChange: (patch: Partial<FlowNode>) => void;
}) {
  const metric = typeof node.metric === "string" ? node.metric : "";
  const hours =
    typeof node.evaluation_hours === "number" ? node.evaluation_hours : "";
  const autoPromote = node.auto_promote === true;
  const metricId = useId();
  const windowId = useId();
  const runtimeHoldId = useId();
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs font-semibold text-foreground">A/B test</p>
      <div className="space-y-1">
        <Label htmlFor={metricId} className="text-xs">
          Success metric
        </Label>
        <Select
          id={metricId}
          value={metric}
          onChange={(e) => onChange({ metric: e.target.value })}
        >
          <option value="">— Select metric —</option>
          {AB_METRICS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={windowId} className="text-xs">
          Evaluation window (hours)
        </Label>
        <Input
          id={windowId}
          type="number"
          min={1}
          value={hours === "" ? "" : String(hours)}
          onChange={(e) =>
            onChange({
              evaluation_hours:
                e.target.value === "" ? undefined : Number(e.target.value),
            })
          }
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-foreground">
        <Checkbox
          checked={autoPromote}
          disabled
          aria-describedby={runtimeHoldId}
        />
        Auto-promote preference (stored only)
      </label>
      <p
        id={runtimeHoldId}
        role="note"
        className="text-[11px] text-muted-foreground"
      >
        Configuration only. Winner evaluation and automatic promotion are
        release-held; saving this node does not select or promote a variant.
      </p>
    </div>
  );
}

function VariantsEditor({
  variants,
  options,
  nodeCatalog,
  conditionFields,
  onChange,
}: {
  variants: Array<Record<string, unknown>>;
  options: FlowNode[];
  nodeCatalog: CatalogItem[];
  conditionFields: ConditionFieldSpec[];
  onChange: (v: Array<Record<string, unknown>>) => void;
}) {
  // One `useId` base per editor; rows suffix it with their index so every
  // row's percentage/destination pair gets its own unique, clickable label.
  const rowIdBase = useId();
  const total = variants.reduce((s, v) => s + (Number(v.percentage) || 0), 0);
  // Nothing downstream rejects a bad split: ValidateFlowGraph has no
  // percentage rule and the save succeeds, so a flow can be stored with a
  // routing table that can never allocate. The amber total on its own never
  // said what was wrong, so name both faults here.
  const outOfRange = (value: unknown): boolean => {
    const pct = Number(value);
    return !Number.isFinite(pct) || pct < 0 || pct > 100;
  };
  const problems = [
    variants.some((v) => outOfRange(v.percentage))
      ? "Each variant must be between 0% and 100%."
      : null,
    total === 100 ? null : `Variants must total 100% — currently ${total}%.`,
  ].filter((message): message is string => message !== null);
  const problemId = `${rowIdBase}-allocation`;
  const update = (i: number, patch: Record<string, unknown>) =>
    onChange(variants.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  const add = () =>
    onChange([
      ...variants,
      {
        id: `v_${Math.random().toString(36).slice(2, 7)}`,
        percentage: 0,
        next: "",
      },
    ]);
  const remove = (i: number) =>
    onChange(variants.filter((_, idx) => idx !== i));

  return (
    <div
      className="space-y-2 rounded-md border border-border bg-muted/30 p-3"
      aria-describedby={problems.length > 0 ? problemId : undefined}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-foreground">Variants</p>
        <span
          className={
            total === 100
              ? "text-xs text-success"
              : "text-xs text-warning-emphasis"
          }
        >
          {total}%
        </span>
      </div>
      {problems.length > 0 ? (
        <p
          id={problemId}
          role="note"
          className="text-[11px] text-warning-emphasis"
        >
          {problems.join(" ")}
        </p>
      ) : null}
      {variants.map((v, i) => (
        <div key={i} className="flex items-end gap-2">
          <div className="w-16 space-y-1">
            <Label htmlFor={`${rowIdBase}-pct-${i}`} className="text-xs">
              %
            </Label>
            <Input
              id={`${rowIdBase}-pct-${i}`}
              type="number"
              min={0}
              max={100}
              step={1}
              aria-invalid={outOfRange(v.percentage) || undefined}
              className="h-8"
              value={v.percentage == null ? "" : String(v.percentage)}
              onChange={(e) =>
                update(i, {
                  percentage:
                    e.target.value === "" ? 0 : Number(e.target.value),
                })
              }
            />
          </div>
          <div className="flex-1 space-y-1">
            <Label htmlFor={`${rowIdBase}-next-${i}`} className="text-xs">
              Go to
            </Label>
            <Select
              id={`${rowIdBase}-next-${i}`}
              className="h-8"
              value={typeof v.next === "string" ? v.next : ""}
              onChange={(e) => update(i, { next: e.target.value })}
            >
              <option value="">— End —</option>
              {options.map((n) => (
                <option key={n.id} value={n.id}>
                  {nodeOptionLabel(n, nodeCatalog, { conditionFields })}
                </option>
              ))}
            </Select>
          </div>
          <IconButton
            size="sm"
            aria-label="Remove variant"
            className="mb-0.5 text-muted-foreground hover:text-destructive"
            onClick={() => remove(i)}
          >
            <span aria-hidden className="text-xs">
              ✕
            </span>
          </IconButton>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        + Add variant
      </Button>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const inputId = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={inputId} className="text-xs">
        {label}
      </Label>
      <Input
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function humanizeKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
