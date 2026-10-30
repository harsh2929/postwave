// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { FieldDiagnostics, hasFieldError } from "./field-diagnostics";
import { RichTextEditor } from "./rich-text-editor";
import { NODE_ROLE_LABELS } from "@/lib/semantic-email/authoring";
import {
  CONDITION_OPERATORS,
  RESERVATION_STATUSES,
  ROLES_BY_TYPE,
  SLOT_SEMANTIC_CLASSES,
  SOURCE_KINDS,
  STRUCTURED_DATA_KINDS,
  isNodeType,
  type Condition,
  type DateTimeContent,
  type Diagnostic,
  type NodeContent,
  type NodeRole,
  type NodeType,
  type RichText,
  type SemanticNode,
  type SlotSemanticClass,
  type SourceKind,
  type StructuredDataKind,
} from "@/lib/semantic-email/types";

interface Props {
  node: SemanticNode;
  index: number;
  nodes: readonly SemanticNode[];
  diagnostics: readonly Diagnostic[];
  onChange: (next: SemanticNode) => void;
}

function TextField({
  id,
  label,
  value,
  pointer,
  diagnostics,
  onChange,
  hint,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  pointer: string;
  diagnostics: readonly Diagnostic[];
  onChange: (next: string) => void;
  hint?: string;
  placeholder?: string;
}) {
  const errorId = `${id}-diagnostics`;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        aria-invalid={hasFieldError(diagnostics, pointer)}
        aria-describedby={errorId}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
      <FieldDiagnostics
        diagnostics={diagnostics}
        pointer={pointer}
        id={errorId}
      />
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  pointer,
  diagnostics,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  pointer: string;
  diagnostics: readonly Diagnostic[];
  onChange: (next: number) => void;
}) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        value={String(value)}
        aria-invalid={hasFieldError(diagnostics, pointer)}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          onChange(Number.isFinite(parsed) ? Math.trunc(parsed) : 0);
        }}
      />
      <FieldDiagnostics diagnostics={diagnostics} pointer={pointer} />
    </div>
  );
}

function DateTimeFields({
  idPrefix,
  label,
  value,
  pointer,
  diagnostics,
  onChange,
}: {
  idPrefix: string;
  label: string;
  value: DateTimeContent;
  pointer: string;
  diagnostics: readonly Diagnostic[];
  onChange: (next: DateTimeContent) => void;
}) {
  return (
    <fieldset className="rounded-md border p-3">
      <legend className="px-1 text-xs font-medium text-muted-foreground">
        {label}
      </legend>
      <div className="space-y-2">
        <TextField
          id={`${idPrefix}-display`}
          label="Display value"
          value={value.display_value}
          pointer={pointer + "/display_value"}
          diagnostics={diagnostics}
          hint="What the reader sees, in their words."
          onChange={(next) => onChange({ ...value, display_value: next })}
        />
        <TextField
          id={`${idPrefix}-rfc3339`}
          label="Exact instant (RFC 3339)"
          value={value.rfc3339}
          pointer={pointer + "/rfc3339"}
          diagnostics={diagnostics}
          placeholder="2026-08-14T16:00:00+05:30"
          hint="Must carry an explicit numeric offset that matches the zone at that instant."
          onChange={(next) => onChange({ ...value, rfc3339: next })}
        />
        <TextField
          id={`${idPrefix}-timezone`}
          label="IANA time zone"
          value={value.timezone}
          pointer={pointer + "/timezone"}
          diagnostics={diagnostics}
          placeholder="Asia/Kolkata"
          onChange={(next) => onChange({ ...value, timezone: next })}
        />
      </div>
    </fieldset>
  );
}

function NodeRefSelect({
  id,
  label,
  value,
  nodes,
  allowed,
  pointer,
  diagnostics,
  onChange,
  optional,
}: {
  id: string;
  label: string;
  value: string;
  nodes: readonly SemanticNode[];
  allowed: readonly NodeType[];
  pointer: string;
  diagnostics: readonly Diagnostic[];
  onChange: (next: string) => void;
  optional?: boolean;
}) {
  // Only nodes of a permitted type are offered. A structured-data declaration
  // that points at the wrong kind of node is not a typo the author can see in
  // the rendered email — it is markup a provider silently ignores.
  const candidates = nodes.filter((node) =>
    (allowed as readonly string[]).includes(node.type),
  );
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        value={value}
        aria-invalid={hasFieldError(diagnostics, pointer)}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{optional ? "— none —" : "— choose a node —"}</option>
        {candidates.map((node) => (
          <option key={node.id} value={node.id}>
            {node.id} ({node.type})
          </option>
        ))}
      </Select>
      <FieldDiagnostics diagnostics={diagnostics} pointer={pointer} />
    </div>
  );
}

export function NodeProperties({
  node,
  index,
  nodes,
  diagnostics,
  onChange,
}: Props) {
  const base = `/nodes/${index}`;
  const contentPointer = `${base}/content`;
  const idPrefix = `semantic-node-${index}`;
  const type = isNodeType(node.type) ? node.type : null;

  const patchContent = (content: NodeContent) => onChange({ ...node, content });

  const richTextEditor = (
    label: string,
    value: RichText,
    pointer: string,
    onRich: (next: RichText) => void,
    key: string,
  ) => (
    <RichTextEditor
      label={label}
      value={value}
      pointer={pointer}
      diagnostics={diagnostics}
      idPrefix={`${idPrefix}-${key}`}
      onChange={onRich}
    />
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id={`${idPrefix}-id`}
          label="Node id"
          value={node.id}
          pointer={`${base}/id`}
          diagnostics={diagnostics}
          hint="Stable identity. Edits, receipts and diagnostics hang on it."
          onChange={(next) => onChange({ ...node, id: next })}
        />
        <div>
          <Label htmlFor={`${idPrefix}-role`}>Role</Label>
          <Select
            id={`${idPrefix}-role`}
            value={node.role}
            aria-invalid={hasFieldError(diagnostics, `${base}/role`)}
            onChange={(event) =>
              onChange({ ...node, role: event.target.value as NodeRole })
            }
          >
            {/* Only the roles this node type allows. Role says WHY the node
                exists, which is what lets action extraction tell a primary CTA
                from an unsubscribe link. */}
            {(type ? ROLES_BY_TYPE[type] : []).map((role) => (
              <option key={role} value={role}>
                {NODE_ROLE_LABELS[role]}
              </option>
            ))}
            {/* An unknown TYPE has no allowed-role list at all, so without this
                the picker would be empty and the role the document actually
                carries would be shown nowhere. Same escape hatch, same words. */}
            {!type ||
            !(ROLES_BY_TYPE[type] as readonly string[]).includes(node.role) ? (
              <option value={node.role}>{node.role} (not valid here)</option>
            ) : null}
          </Select>
          <FieldDiagnostics
            diagnostics={diagnostics}
            pointer={`${base}/role`}
          />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-source`}>Provenance</Label>
          <Select
            id={`${idPrefix}-source`}
            value={node.provenance.source}
            onChange={(event) =>
              onChange({
                ...node,
                provenance: {
                  ...node.provenance,
                  source: event.target.value as SourceKind,
                },
              })
            }
          >
            {SOURCE_KINDS.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </Select>
          <FieldDiagnostics
            diagnostics={diagnostics}
            pointer={`${base}/provenance`}
            mode="subtree"
          />
        </div>
      </div>

      <FieldDiagnostics diagnostics={diagnostics} pointer={contentPointer} />

      {type === null ? (
        // `type` is a string in the schema so an unsupported value from the
        // API is representable and can be REPORTED. Every content editor below
        // is keyed to a member of the closed union, so none of them fires here
        // — and a panel that showed neither a type nor an editor would read as
        // an empty node rather than an unknown one.
        <p className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">
          Unknown node type <code>{node.type}</code> — this build cannot edit
          it. The node is preserved exactly as it arrived and can be changed in
          the JSON view.
        </p>
      ) : null}

      {type === "heading" && node.content.heading && (
        <div className="space-y-3">
          <NumberField
            id={`${idPrefix}-level`}
            label="Level (1–6)"
            value={node.content.heading.level}
            pointer={`${contentPointer}/heading/level`}
            diagnostics={diagnostics}
            onChange={(level) =>
              patchContent({ heading: { ...node.content.heading!, level } })
            }
          />
          {richTextEditor(
            "Heading text",
            node.content.heading.text,
            `${contentPointer}/heading/text`,
            (text) =>
              patchContent({ heading: { ...node.content.heading!, text } }),
            "heading",
          )}
        </div>
      )}

      {type === "paragraph" &&
        node.content.paragraph &&
        richTextEditor(
          "Paragraph text",
          node.content.paragraph.text,
          `${contentPointer}/paragraph/text`,
          (text) => patchContent({ paragraph: { text } }),
          "paragraph",
        )}

      {type === "list" && node.content.list && (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={node.content.list.ordered}
              onChange={(event) =>
                patchContent({
                  list: {
                    ...node.content.list!,
                    ordered: event.target.checked,
                  },
                })
              }
            />
            Ordered list
          </label>
          <FieldDiagnostics
            diagnostics={diagnostics}
            pointer={`${contentPointer}/list/items`}
          />
          {node.content.list.items.map((item, itemIndex) => (
            <div key={itemIndex} className="space-y-1">
              {richTextEditor(
                `Item ${itemIndex + 1}`,
                item,
                `${contentPointer}/list/items/${itemIndex}`,
                (next) => {
                  const items = [...node.content.list!.items];
                  items[itemIndex] = next;
                  patchContent({ list: { ...node.content.list!, items } });
                },
                `item-${itemIndex}`,
              )}
              <div className="flex gap-2 text-xs">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={itemIndex === 0}
                  aria-label={`Move item ${itemIndex + 1} up`}
                  onClick={() => {
                    const items = [...node.content.list!.items];
                    [items[itemIndex - 1], items[itemIndex]] = [
                      items[itemIndex],
                      items[itemIndex - 1],
                    ];
                    patchContent({ list: { ...node.content.list!, items } });
                  }}
                >
                  ↑ Up
                </button>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={itemIndex === node.content.list!.items.length - 1}
                  aria-label={`Move item ${itemIndex + 1} down`}
                  onClick={() => {
                    const items = [...node.content.list!.items];
                    [items[itemIndex + 1], items[itemIndex]] = [
                      items[itemIndex],
                      items[itemIndex + 1],
                    ];
                    patchContent({ list: { ...node.content.list!, items } });
                  }}
                >
                  ↓ Down
                </button>
                <button
                  type="button"
                  className="ml-auto text-destructive hover:text-destructive/80"
                  aria-label={`Remove item ${itemIndex + 1}`}
                  onClick={() =>
                    patchContent({
                      list: {
                        ...node.content.list!,
                        items: node.content.list!.items.filter(
                          (_, position) => position !== itemIndex,
                        ),
                      },
                    })
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="rounded border px-2 py-1 text-xs hover:bg-accent"
            onClick={() =>
              patchContent({
                list: {
                  ...node.content.list!,
                  items: [
                    ...node.content.list!.items,
                    {
                      runs: [
                        {
                          kind: "text",
                          text: "New item",
                          url: "",
                          accessible_label: "",
                          slot: null,
                        },
                      ],
                    },
                  ],
                },
              })
            }
          >
            + Add item
          </button>
        </div>
      )}

      {type === "answer" && node.content.answer && (
        <div className="space-y-3">
          {richTextEditor(
            "Question",
            node.content.answer.question,
            `${contentPointer}/answer/question`,
            (question) =>
              patchContent({ answer: { ...node.content.answer!, question } }),
            "question",
          )}
          {richTextEditor(
            "Answer",
            node.content.answer.answer,
            `${contentPointer}/answer/answer`,
            (answer) =>
              patchContent({ answer: { ...node.content.answer!, answer } }),
            "answer",
          )}
        </div>
      )}

      {type === "legal" &&
        node.content.legal &&
        richTextEditor(
          "Legal text",
          node.content.legal.text,
          `${contentPointer}/legal/text`,
          (text) => patchContent({ legal: { text } }),
          "legal",
        )}

      {type === "action" && node.content.action && (
        <div className="space-y-3">
          <TextField
            id={`${idPrefix}-action-id`}
            label="Action id"
            value={node.content.action.action_id}
            pointer={`${contentPointer}/action/action_id`}
            diagnostics={diagnostics}
            hint="Stable identity for attribution; unique in the document."
            onChange={(action_id) =>
              patchContent({ action: { ...node.content.action!, action_id } })
            }
          />
          <TextField
            id={`${idPrefix}-action-label`}
            label="Label"
            value={node.content.action.label}
            pointer={`${contentPointer}/action/label`}
            diagnostics={diagnostics}
            onChange={(label) =>
              patchContent({ action: { ...node.content.action!, label } })
            }
          />
          <TextField
            id={`${idPrefix}-action-url`}
            label="Canonical URL"
            value={node.content.action.canonical_url}
            pointer={`${contentPointer}/action/canonical_url`}
            diagnostics={diagnostics}
            hint="Absolute http(s), no fragment, no embedded credentials."
            onChange={(canonical_url) =>
              patchContent({
                action: { ...node.content.action!, canonical_url },
              })
            }
          />
          <TextField
            id={`${idPrefix}-action-description`}
            label="Accessible description (optional)"
            value={node.content.action.accessible_description}
            pointer={`${contentPointer}/action/accessible_description`}
            diagnostics={diagnostics}
            onChange={(accessible_description) =>
              patchContent({
                action: { ...node.content.action!, accessible_description },
              })
            }
          />
        </div>
      )}

      {type === "image" && node.content.image && (
        <div className="space-y-3">
          <TextField
            id={`${idPrefix}-image-url`}
            label="Image URL (HTTPS)"
            value={node.content.image.url}
            pointer={`${contentPointer}/image/url`}
            diagnostics={diagnostics}
            onChange={(url) =>
              patchContent({ image: { ...node.content.image!, url } })
            }
          />
          <TextField
            id={`${idPrefix}-image-alt`}
            label="Alt text"
            value={node.content.image.alt}
            pointer={`${contentPointer}/image/alt`}
            diagnostics={diagnostics}
            hint={
              node.role === "decorative_image"
                ? "A decorative image must have empty alt text, or a screen reader announces decoration as content."
                : "An informative image requires alt text: it is the only thing the plain-text projection carries."
            }
            onChange={(alt) =>
              patchContent({ image: { ...node.content.image!, alt } })
            }
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              id={`${idPrefix}-image-width`}
              label="Width"
              value={node.content.image.width}
              pointer={`${contentPointer}/image`}
              diagnostics={[]}
              onChange={(width) =>
                patchContent({ image: { ...node.content.image!, width } })
              }
            />
            <NumberField
              id={`${idPrefix}-image-height`}
              label="Height"
              value={node.content.image.height}
              pointer={`${contentPointer}/image`}
              diagnostics={[]}
              onChange={(height) =>
                patchContent({ image: { ...node.content.image!, height } })
              }
            />
          </div>
          <FieldDiagnostics
            diagnostics={diagnostics}
            pointer={`${contentPointer}/image`}
          />
        </div>
      )}

      {type === "datetime" && node.content.datetime && (
        <DateTimeFields
          idPrefix={`${idPrefix}-datetime`}
          label="Event date & time"
          value={node.content.datetime}
          pointer={`${contentPointer}/datetime`}
          diagnostics={diagnostics}
          onChange={(datetime) => patchContent({ datetime })}
        />
      )}

      {type === "deadline" && node.content.deadline && (
        <DateTimeFields
          idPrefix={`${idPrefix}-deadline`}
          label="Deadline"
          value={node.content.deadline}
          pointer={`${contentPointer}/deadline`}
          diagnostics={diagnostics}
          onChange={(deadline) => patchContent({ deadline })}
        />
      )}

      {type === "money" && node.content.money && (
        <div className="space-y-3">
          <TextField
            id={`${idPrefix}-money-display`}
            label="Display value"
            value={node.content.money.display_value}
            pointer={`${contentPointer}/money/display_value`}
            diagnostics={diagnostics}
            placeholder="₹1,499"
            onChange={(display_value) =>
              patchContent({ money: { ...node.content.money!, display_value } })
            }
          />
          <TextField
            id={`${idPrefix}-money-amount`}
            label="Exact amount"
            value={node.content.money.amount}
            pointer={`${contentPointer}/money/amount`}
            diagnostics={diagnostics}
            hint="Base-10 decimal, never floating point: 1499 or 1499.50."
            onChange={(amount) =>
              patchContent({ money: { ...node.content.money!, amount } })
            }
          />
          <TextField
            id={`${idPrefix}-money-currency`}
            label="Currency (ISO 4217)"
            value={node.content.money.currency}
            pointer={`${contentPointer}/money/currency`}
            diagnostics={diagnostics}
            placeholder="INR"
            onChange={(currency) =>
              patchContent({ money: { ...node.content.money!, currency } })
            }
          />
        </div>
      )}

      {type === "offer" && node.content.offer && (
        <div className="space-y-3">
          {richTextEditor(
            "Description",
            node.content.offer.description,
            `${contentPointer}/offer/description`,
            (description) =>
              patchContent({ offer: { ...node.content.offer!, description } }),
            "offer-description",
          )}
          <TextField
            id={`${idPrefix}-offer-code`}
            label="Code (optional)"
            value={node.content.offer.code}
            pointer={`${contentPointer}/offer/code`}
            diagnostics={diagnostics}
            onChange={(code) =>
              patchContent({ offer: { ...node.content.offer!, code } })
            }
          />
          {richTextEditor(
            "Terms",
            node.content.offer.terms,
            `${contentPointer}/offer/terms`,
            (terms) =>
              patchContent({ offer: { ...node.content.offer!, terms } }),
            "offer-terms",
          )}
          <TextField
            id={`${idPrefix}-offer-canonical`}
            label="Canonical offer id (optional)"
            value={node.content.offer.canonical_offer_id}
            pointer={`${contentPointer}/offer/canonical_offer_id`}
            diagnostics={diagnostics}
            placeholder="3f2504e0-4f89-11d3-9a0c-0305e82c3301"
            hint="Names the offer entity. A reference, not a copy: a copied price goes stale silently for every recipient."
            onChange={(canonical_offer_id) =>
              patchContent({
                offer: { ...node.content.offer!, canonical_offer_id },
              })
            }
          />
          <div className="grid gap-3">
            {node.content.offer.availability_starts ? (
              <DateTimeFields
                idPrefix={`${idPrefix}-offer-starts`}
                label="Availability starts"
                value={node.content.offer.availability_starts}
                pointer={`${contentPointer}/offer/availability_starts`}
                diagnostics={diagnostics}
                onChange={(availability_starts) =>
                  patchContent({
                    offer: { ...node.content.offer!, availability_starts },
                  })
                }
              />
            ) : null}
            {node.content.offer.availability_ends ? (
              <DateTimeFields
                idPrefix={`${idPrefix}-offer-ends`}
                label="Availability ends"
                value={node.content.offer.availability_ends}
                pointer={`${contentPointer}/offer/availability_ends`}
                diagnostics={diagnostics}
                onChange={(availability_ends) =>
                  patchContent({
                    offer: { ...node.content.offer!, availability_ends },
                  })
                }
              />
            ) : null}
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded border px-2 py-1 text-xs hover:bg-accent"
                onClick={() =>
                  patchContent({
                    offer: {
                      ...node.content.offer!,
                      availability_starts: node.content.offer!
                        .availability_starts
                        ? null
                        : { display_value: "", rfc3339: "", timezone: "UTC" },
                    },
                  })
                }
              >
                {node.content.offer.availability_starts ? "Remove" : "Add"}{" "}
                start
              </button>
              <button
                type="button"
                className="rounded border px-2 py-1 text-xs hover:bg-accent"
                onClick={() =>
                  patchContent({
                    offer: {
                      ...node.content.offer!,
                      availability_ends: node.content.offer!.availability_ends
                        ? null
                        : { display_value: "", rfc3339: "", timezone: "UTC" },
                    },
                  })
                }
              >
                {node.content.offer.availability_ends ? "Remove" : "Add"} end
              </button>
            </div>
          </div>
        </div>
      )}

      {type === "location" && node.content.location && (
        <div className="space-y-3">
          <TextField
            id={`${idPrefix}-location-name`}
            label="Place name"
            value={node.content.location.name}
            pointer={`${contentPointer}/location/name`}
            diagnostics={diagnostics}
            onChange={(name) =>
              patchContent({ location: { ...node.content.location!, name } })
            }
          />
          {(
            [
              ["street_address", "Street address"],
              ["address_locality", "Locality"],
              ["address_region", "Region (optional)"],
              ["postal_code", "Postal code (optional)"],
              ["address_country", "Country (ISO 3166-1 alpha-2)"],
            ] as const
          ).map(([key, label]) => (
            <TextField
              key={key}
              id={`${idPrefix}-location-${key}`}
              label={label}
              value={node.content.location!.address[key]}
              pointer={`${contentPointer}/location/address/${key}`}
              diagnostics={diagnostics}
              onChange={(next) =>
                patchContent({
                  location: {
                    ...node.content.location!,
                    address: { ...node.content.location!.address, [key]: next },
                  },
                })
              }
            />
          ))}
        </div>
      )}

      {type === "product" && node.content.product && (
        <div className="space-y-3">
          {(
            [
              ["name", "Name"],
              ["sku", "SKU (optional)"],
              ["canonical_url", "Canonical URL (optional)"],
              ["image_url", "Image URL (optional, HTTPS)"],
            ] as const
          ).map(([key, label]) => (
            <TextField
              key={key}
              id={`${idPrefix}-product-${key}`}
              label={label}
              value={node.content.product![key]}
              pointer={`${contentPointer}/product/${key}`}
              diagnostics={diagnostics}
              onChange={(next) =>
                patchContent({
                  product: { ...node.content.product!, [key]: next },
                })
              }
            />
          ))}
        </div>
      )}

      {type === "fact" && node.content.fact && (
        <div className="space-y-3">
          <TextField
            id={`${idPrefix}-fact-label`}
            label="Label"
            value={node.content.fact.label}
            pointer={`${contentPointer}/fact/label`}
            diagnostics={diagnostics}
            onChange={(label) =>
              patchContent({ fact: { ...node.content.fact!, label } })
            }
          />
          <TextField
            id={`${idPrefix}-fact-value`}
            label="Value"
            value={node.content.fact.value}
            pointer={`${contentPointer}/fact/value`}
            diagnostics={diagnostics}
            onChange={(value) =>
              patchContent({ fact: { ...node.content.fact!, value } })
            }
          />
        </div>
      )}

      {type === "personalization" && node.content.personalization && (
        <div className="space-y-3">
          <TextField
            id={`${idPrefix}-personalization-label`}
            label="Label (optional)"
            value={node.content.personalization.label}
            pointer={`${contentPointer}/personalization/label`}
            diagnostics={diagnostics}
            onChange={(label) =>
              patchContent({
                personalization: { ...node.content.personalization!, label },
              })
            }
          />
          <TextField
            id={`${idPrefix}-personalization-slot-id`}
            label="Slot id"
            value={node.content.personalization.slot.id}
            pointer={`${contentPointer}/personalization/slot/id`}
            diagnostics={diagnostics}
            onChange={(id) =>
              patchContent({
                personalization: {
                  ...node.content.personalization!,
                  slot: { ...node.content.personalization!.slot, id },
                },
              })
            }
          />
          <div>
            <Label htmlFor={`${idPrefix}-personalization-class`}>
              Semantic class
            </Label>
            <Select
              id={`${idPrefix}-personalization-class`}
              value={node.content.personalization.slot.semantic_class}
              onChange={(event) =>
                patchContent({
                  personalization: {
                    ...node.content.personalization!,
                    slot: {
                      ...node.content.personalization!.slot,
                      semantic_class: event.target.value as SlotSemanticClass,
                    },
                  },
                })
              }
            >
              {SLOT_SEMANTIC_CLASSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </div>
          <TextField
            id={`${idPrefix}-personalization-fallback`}
            label="Fallback"
            value={node.content.personalization.slot.fallback}
            pointer={`${contentPointer}/personalization/slot/fallback`}
            diagnostics={diagnostics}
            hint="A required slot with no fallback fails compilation for any recipient who lacks a value."
            onChange={(fallback) =>
              patchContent({
                personalization: {
                  ...node.content.personalization!,
                  slot: { ...node.content.personalization!.slot, fallback },
                },
              })
            }
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={node.content.personalization.slot.required}
              onChange={(event) =>
                patchContent({
                  personalization: {
                    ...node.content.personalization!,
                    slot: {
                      ...node.content.personalization!.slot,
                      required: event.target.checked,
                    },
                  },
                })
              }
            />
            Required
          </label>
        </div>
      )}

      {type === "divider" && (
        <p className="text-sm text-muted-foreground">
          A divider has no content. Presence is the whole of it: it renders as a
          rule in HTML and is dropped from the plain-text projection, because
          decoration competes with content for a summariser&apos;s attention.
        </p>
      )}

      {type === "poll" && node.content.poll && (
        <div className="space-y-3">
          <TextField
            id={`${idPrefix}-poll-id`}
            label="Poll id"
            value={node.content.poll.poll_id}
            pointer={`${contentPointer}/poll/poll_id`}
            diagnostics={diagnostics}
            hint="Stable across revisions so responses collected before an edit still belong to this poll."
            onChange={(poll_id) =>
              patchContent({ poll: { ...node.content.poll!, poll_id } })
            }
          />
          {richTextEditor(
            "Question",
            node.content.poll.question,
            `${contentPointer}/poll/question`,
            (question) =>
              patchContent({ poll: { ...node.content.poll!, question } }),
            "poll-question",
          )}
          <FieldDiagnostics
            diagnostics={diagnostics}
            pointer={`${contentPointer}/poll/options`}
          />
          <ol className="space-y-3">
            {node.content.poll.options.map((option, optionIndex) => (
              <li key={optionIndex} className="rounded-md border p-2">
                <TextField
                  id={`${idPrefix}-poll-option-${optionIndex}-id`}
                  label={`Option ${optionIndex + 1} id`}
                  value={option.option_id}
                  pointer={`${contentPointer}/poll/options/${optionIndex}/option_id`}
                  diagnostics={diagnostics}
                  hint="What a response records. Two options with the same id merge into one tally."
                  onChange={(option_id) => {
                    const options = [...node.content.poll!.options];
                    options[optionIndex] = { ...option, option_id };
                    patchContent({ poll: { ...node.content.poll!, options } });
                  }}
                />
                <div className="mt-2">
                  {richTextEditor(
                    "Label",
                    option.label,
                    `${contentPointer}/poll/options/${optionIndex}/label`,
                    (label) => {
                      const options = [...node.content.poll!.options];
                      options[optionIndex] = { ...option, label };
                      patchContent({
                        poll: { ...node.content.poll!, options },
                      });
                    },
                    `poll-option-${optionIndex}`,
                  )}
                </div>
                <div className="mt-1.5 flex gap-2 text-xs">
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    disabled={optionIndex === 0}
                    aria-label={`Move option ${optionIndex + 1} up`}
                    onClick={() => {
                      const options = [...node.content.poll!.options];
                      [options[optionIndex - 1], options[optionIndex]] = [
                        options[optionIndex],
                        options[optionIndex - 1],
                      ];
                      patchContent({
                        poll: { ...node.content.poll!, options },
                      });
                    }}
                  >
                    ↑ Up
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    disabled={
                      optionIndex === node.content.poll!.options.length - 1
                    }
                    aria-label={`Move option ${optionIndex + 1} down`}
                    onClick={() => {
                      const options = [...node.content.poll!.options];
                      [options[optionIndex + 1], options[optionIndex]] = [
                        options[optionIndex],
                        options[optionIndex + 1],
                      ];
                      patchContent({
                        poll: { ...node.content.poll!, options },
                      });
                    }}
                  >
                    ↓ Down
                  </button>
                  <button
                    type="button"
                    className="ml-auto text-destructive hover:text-destructive/80"
                    aria-label={`Remove option ${optionIndex + 1}`}
                    onClick={() =>
                      patchContent({
                        poll: {
                          ...node.content.poll!,
                          options: node.content.poll!.options.filter(
                            (_, position) => position !== optionIndex,
                          ),
                        },
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="rounded border px-2 py-1 text-xs hover:bg-accent"
            onClick={() => {
              const options = node.content.poll!.options;
              // A fresh id derived from position, not a copy of the previous
              // option's: reusing one would merge two choices into one tally.
              let suffix = options.length + 1;
              const taken = new Set(options.map((option) => option.option_id));
              while (taken.has(`option_${suffix}`)) suffix += 1;
              patchContent({
                poll: {
                  ...node.content.poll!,
                  options: [
                    ...options,
                    {
                      option_id: `option_${suffix}`,
                      label: {
                        runs: [
                          {
                            kind: "text",
                            text: `Option ${options.length + 1}`,
                            url: "",
                            accessible_label: "",
                            slot: null,
                          },
                        ],
                      },
                    },
                  ],
                },
              });
            }}
          >
            + Add option
          </button>
        </div>
      )}

      {type === "structured_data" && node.content.structured_data && (
        <StructuredDataProperties
          idPrefix={idPrefix}
          content={node.content.structured_data}
          nodes={nodes}
          pointer={`${contentPointer}/structured_data`}
          diagnostics={diagnostics}
          onChange={(structured_data) => patchContent({ structured_data })}
        />
      )}

      <ConditionsEditor
        idPrefix={idPrefix}
        base={base}
        conditions={node.conditions}
        diagnostics={diagnostics}
        onChange={(conditions) => onChange({ ...node, conditions })}
      />

      {Object.keys(node.localizations).length > 0 ? (
        <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
          {Object.keys(node.localizations).length} localization(s) —{" "}
          {Object.keys(node.localizations).sort().join(", ")} — are preserved
          exactly and edited in the JSON view. A localization may translate
          words but never re-point identity, so the block editor does not offer
          to change them here.
        </p>
      ) : null}
    </div>
  );
}

function ConditionsEditor({
  idPrefix,
  base,
  conditions,
  diagnostics,
  onChange,
}: {
  idPrefix: string;
  base: string;
  conditions: readonly Condition[];
  diagnostics: readonly Diagnostic[];
  onChange: (next: Condition[]) => void;
}) {
  return (
    <fieldset className="rounded-md border p-3">
      <legend className="px-1 text-xs font-medium text-muted-foreground">
        Conditions ({conditions.length})
      </legend>
      <FieldDiagnostics
        diagnostics={diagnostics}
        pointer={`${base}/conditions`}
      />
      <div className="space-y-2">
        {conditions.map((condition, conditionIndex) => {
          const pointer = `${base}/conditions/${conditionIndex}`;
          const controlId = `${idPrefix}-condition-${conditionIndex}`;
          const equality =
            condition.operator === "equals" ||
            condition.operator === "not_equals";
          return (
            <div key={conditionIndex} className="rounded border p-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <TextField
                  id={`${controlId}-id`}
                  label="Condition id"
                  value={condition.id}
                  pointer={`${pointer}/id`}
                  diagnostics={diagnostics}
                  onChange={(id) => {
                    const next = [...conditions];
                    next[conditionIndex] = { ...condition, id };
                    onChange(next);
                  }}
                />
                <TextField
                  id={`${controlId}-slot`}
                  label="Slot id"
                  value={condition.slot_id}
                  pointer={`${pointer}/slot_id`}
                  diagnostics={diagnostics}
                  onChange={(slot_id) => {
                    const next = [...conditions];
                    next[conditionIndex] = { ...condition, slot_id };
                    onChange(next);
                  }}
                />
                <div>
                  <Label htmlFor={`${controlId}-operator`}>Operator</Label>
                  <Select
                    id={`${controlId}-operator`}
                    value={condition.operator}
                    onChange={(event) => {
                      const operator = event.target.value;
                      const next = [...conditions];
                      // present/absent forbid a value; carrying one over would
                      // be an error the author never typed.
                      next[conditionIndex] = {
                        ...condition,
                        operator,
                        value:
                          operator === "equals" || operator === "not_equals"
                            ? condition.value
                            : "",
                      };
                      onChange(next);
                    }}
                  >
                    {CONDITION_OPERATORS.map((operator) => (
                      <option key={operator} value={operator}>
                        {operator}
                      </option>
                    ))}
                  </Select>
                  <FieldDiagnostics
                    diagnostics={diagnostics}
                    pointer={`${pointer}/operator`}
                  />
                </div>
                {equality ? (
                  <TextField
                    id={`${controlId}-value`}
                    label="Value"
                    value={condition.value}
                    pointer={`${pointer}/value`}
                    diagnostics={diagnostics}
                    onChange={(value) => {
                      const next = [...conditions];
                      next[conditionIndex] = { ...condition, value };
                      onChange(next);
                    }}
                  />
                ) : null}
              </div>
              <button
                type="button"
                className="mt-1.5 text-xs text-destructive hover:text-destructive/80"
                aria-label={`Remove condition ${conditionIndex + 1}`}
                onClick={() =>
                  onChange(
                    conditions.filter(
                      (_, position) => position !== conditionIndex,
                    ),
                  )
                }
              >
                Remove condition
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="mt-2 rounded border px-2 py-1 text-xs hover:bg-accent"
        onClick={() =>
          onChange([
            ...conditions,
            {
              id: `cond_${conditions.length + 1}`,
              slot_id: "",
              operator: "present",
              value: "",
            },
          ])
        }
      >
        + Add condition
      </button>
    </fieldset>
  );
}

function StructuredDataProperties({
  idPrefix,
  content,
  nodes,
  pointer,
  diagnostics,
  onChange,
}: {
  idPrefix: string;
  content: NonNullable<NodeContent["structured_data"]>;
  nodes: readonly SemanticNode[];
  pointer: string;
  diagnostics: readonly Diagnostic[];
  onChange: (next: NonNullable<NodeContent["structured_data"]>) => void;
}) {
  const declarationPointer = `${pointer}/declaration`;

  /**
   * Choosing a kind rewrites the declaration and the use case together.
   * They are not independent: a discount offer is only ever a promotion, an
   * order is only ever transactional, and exactly one declaration may be
   * present. Letting them drift apart would produce structured_kind_mismatch
   * on save.
   */
  const setKind = (kind: StructuredDataKind) => {
    const useCase =
      kind === "discount_offer" || kind === "promotion_card"
        ? "gmail_promotion"
        : "gmail_transaction";
    const declaration =
      kind === "discount_offer"
        ? { discount_offer: { offer_node_id: "" } }
        : kind === "promotion_card"
          ? {
              promotion_card: {
                image_node_id: "",
                action_node_id: "",
                headline_node_id: "",
                price_node_id: "",
                discount_value_node_id: "",
                position: 0,
              },
            }
          : kind === "event_reservation"
            ? {
                event_reservation: {
                  reservation_number_node_id: "",
                  under_name_node_id: "",
                  event_name_node_id: "",
                  start_datetime_node_id: "",
                  location_node_id: "",
                  status_node_id: "",
                  status: "confirmed",
                  action_node_id: "",
                },
              }
            : {
                order: {
                  merchant_node_id: "",
                  order_number_node_id: "",
                  total_node_id: "",
                  items: [],
                  action_node_id: "",
                },
              };
    onChange({ ...content, kind, use_case: useCase, declaration });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Structured data declares provider markup from nodes that are already
        visible in the message. It never carries its own values, so the markup
        and the copy cannot disagree.
      </p>
      <p
        className="rounded-md border p-2 text-xs text-muted-foreground"
        role="note"
      >
        <strong>Deterministic:</strong> this editor validates the typed
        declaration. <strong>Predicted:</strong> sender eligibility and emission
        are decided only by the frozen server compile.{" "}
        <strong>Observed:</strong> provider display stays unknown until
        controlled inbox evidence records it. Valid markup is never displayed
        here as proof that a provider showed it or that it improved
        comprehension.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={content.enabled}
          onChange={(event) =>
            onChange({ ...content, enabled: event.target.checked })
          }
        />
        Enabled
      </label>
      <div>
        <Label htmlFor={`${idPrefix}-structured-kind`}>Kind</Label>
        <Select
          id={`${idPrefix}-structured-kind`}
          value={content.kind}
          onChange={(event) =>
            setKind(event.target.value as StructuredDataKind)
          }
        >
          {STRUCTURED_DATA_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-muted-foreground">
          Use case: <code>{content.use_case}</code> · registry{" "}
          <code>{content.registry_version}</code>
        </p>
        {[
          "",
          "/provider",
          "/registry_version",
          "/use_case",
          "/declaration",
        ].map((suffix) => (
          <FieldDiagnostics
            key={suffix}
            diagnostics={diagnostics}
            pointer={pointer + suffix}
          />
        ))}
      </div>

      {content.declaration.discount_offer ? (
        <NodeRefSelect
          id={`${idPrefix}-structured-offer`}
          label="Offer node"
          value={content.declaration.discount_offer.offer_node_id}
          nodes={nodes}
          allowed={["offer"]}
          pointer={`${declarationPointer}/discount_offer/offer_node_id`}
          diagnostics={diagnostics}
          onChange={(offer_node_id) =>
            onChange({
              ...content,
              declaration: { discount_offer: { offer_node_id } },
            })
          }
        />
      ) : null}

      {content.declaration.promotion_card ? (
        <div className="space-y-2">
          {(
            [
              ["image_node_id", "Image node", ["image"], false],
              ["action_node_id", "Action node", ["action"], false],
              [
                "headline_node_id",
                "Headline node (optional)",
                ["heading", "paragraph", "fact", "product"],
                true,
              ],
              ["price_node_id", "Price node (optional)", ["money"], true],
              [
                "discount_value_node_id",
                "Discount value node (optional)",
                ["money"],
                true,
              ],
            ] as const
          ).map(([key, label, allowed, optional]) => (
            <NodeRefSelect
              key={key}
              id={`${idPrefix}-structured-${key}`}
              label={label}
              value={content.declaration.promotion_card![key]}
              nodes={nodes}
              allowed={allowed}
              optional={optional}
              pointer={`${declarationPointer}/promotion_card/${key}`}
              diagnostics={diagnostics}
              onChange={(next) =>
                onChange({
                  ...content,
                  declaration: {
                    promotion_card: {
                      ...content.declaration.promotion_card!,
                      [key]: next,
                    },
                  },
                })
              }
            />
          ))}
          <NumberField
            id={`${idPrefix}-structured-position`}
            label="Position (0–10)"
            value={content.declaration.promotion_card.position}
            pointer={`${declarationPointer}/promotion_card/position`}
            diagnostics={diagnostics}
            onChange={(position) =>
              onChange({
                ...content,
                declaration: {
                  promotion_card: {
                    ...content.declaration.promotion_card!,
                    position,
                  },
                },
              })
            }
          />
        </div>
      ) : null}

      {content.declaration.event_reservation ? (
        <div className="space-y-2">
          {(
            [
              [
                "reservation_number_node_id",
                "Reservation number",
                ["fact", "personalization"],
                false,
              ],
              [
                "under_name_node_id",
                "Under name",
                ["fact", "personalization"],
                false,
              ],
              [
                "event_name_node_id",
                "Event name",
                ["heading", "fact", "product"],
                false,
              ],
              [
                "start_datetime_node_id",
                "Start date & time",
                ["datetime"],
                false,
              ],
              ["location_node_id", "Location", ["location"], false],
              ["status_node_id", "Status fact", ["fact"], false],
              ["action_node_id", "Action (optional)", ["action"], true],
            ] as const
          ).map(([key, label, allowed, optional]) => (
            <NodeRefSelect
              key={key}
              id={`${idPrefix}-structured-${key}`}
              label={label}
              value={content.declaration.event_reservation![key]}
              nodes={nodes}
              allowed={allowed}
              optional={optional}
              pointer={`${declarationPointer}/event_reservation/${key}`}
              diagnostics={diagnostics}
              onChange={(next) =>
                onChange({
                  ...content,
                  declaration: {
                    event_reservation: {
                      ...content.declaration.event_reservation!,
                      [key]: next,
                    },
                  },
                })
              }
            />
          ))}
          <div>
            <Label htmlFor={`${idPrefix}-structured-status`}>Status</Label>
            <Select
              id={`${idPrefix}-structured-status`}
              value={content.declaration.event_reservation.status}
              onChange={(event) =>
                onChange({
                  ...content,
                  declaration: {
                    event_reservation: {
                      ...content.declaration.event_reservation!,
                      status: event.target.value,
                    },
                  },
                })
              }
            >
              {RESERVATION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              The visible status fact must say the same thing, or the reader and
              the schema disagree.
            </p>
            <FieldDiagnostics
              diagnostics={diagnostics}
              pointer={`${declarationPointer}/event_reservation/status`}
            />
          </div>
        </div>
      ) : null}

      {content.declaration.order ? (
        <div className="space-y-2">
          {(
            [
              ["merchant_node_id", "Merchant", ["fact", "product"], false],
              [
                "order_number_node_id",
                "Order number",
                ["fact", "personalization"],
                false,
              ],
              ["total_node_id", "Total", ["money"], false],
              ["action_node_id", "Action (optional)", ["action"], true],
            ] as const
          ).map(([key, label, allowed, optional]) => (
            <NodeRefSelect
              key={key}
              id={`${idPrefix}-structured-${key}`}
              label={label}
              value={content.declaration.order![key]}
              nodes={nodes}
              allowed={allowed}
              optional={optional}
              pointer={`${declarationPointer}/order/${key}`}
              diagnostics={diagnostics}
              onChange={(next) =>
                onChange({
                  ...content,
                  declaration: {
                    order: { ...content.declaration.order!, [key]: next },
                  },
                })
              }
            />
          ))}
          <FieldDiagnostics
            diagnostics={diagnostics}
            pointer={`${declarationPointer}/order/items`}
          />
          {content.declaration.order.items.map((item, itemIndex) => (
            <div key={itemIndex} className="space-y-2 rounded border p-2">
              {(
                [
                  ["product_node_id", "Product", ["product"]],
                  ["price_node_id", "Price", ["money"]],
                  ["quantity_node_id", "Quantity fact", ["fact"]],
                ] as const
              ).map(([key, label, allowed]) => (
                <NodeRefSelect
                  key={key}
                  id={`${idPrefix}-structured-item-${itemIndex}-${key}`}
                  label={`${label} (item ${itemIndex + 1})`}
                  value={item[key]}
                  nodes={nodes}
                  allowed={allowed}
                  pointer={`${declarationPointer}/order/items/${itemIndex}/${key}`}
                  diagnostics={diagnostics}
                  onChange={(next) => {
                    const items = [...content.declaration.order!.items];
                    items[itemIndex] = { ...item, [key]: next };
                    onChange({
                      ...content,
                      declaration: {
                        order: { ...content.declaration.order!, items },
                      },
                    });
                  }}
                />
              ))}
              <button
                type="button"
                className="text-xs text-destructive hover:text-destructive/80"
                aria-label={`Remove order item ${itemIndex + 1}`}
                onClick={() =>
                  onChange({
                    ...content,
                    declaration: {
                      order: {
                        ...content.declaration.order!,
                        items: content.declaration.order!.items.filter(
                          (_, position) => position !== itemIndex,
                        ),
                      },
                    },
                  })
                }
              >
                Remove item
              </button>
            </div>
          ))}
          <button
            type="button"
            className="rounded border px-2 py-1 text-xs hover:bg-accent"
            onClick={() =>
              onChange({
                ...content,
                declaration: {
                  order: {
                    ...content.declaration.order!,
                    items: [
                      ...content.declaration.order!.items,
                      {
                        product_node_id: "",
                        price_node_id: "",
                        quantity_node_id: "",
                      },
                    ],
                  },
                },
              })
            }
          >
            + Add order item
          </button>
        </div>
      ) : null}
    </div>
  );
}
