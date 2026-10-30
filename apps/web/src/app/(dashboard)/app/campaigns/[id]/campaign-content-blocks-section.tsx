// SPDX-License-Identifier: AGPL-3.0-only

import { type ReactNode } from "react";
import { Plus, Trash2, WandSparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import {
  asCSV,
  asString,
  BLOCK_TYPES,
  defaultBlock,
  labelize,
  type CampaignBlock,
} from "./campaign-detail-helpers";

/**
 * True once a block carries anything a person put there.
 *
 * `defaultBlock` seeds placeholder copy ("New headline", "Write your campaign
 * copy."), so "has content" is true a second after Add and would make every
 * removal ask. Comparing against that seed instead keeps the one-click path
 * for a block nobody has touched, and only guards typed work.
 */
function blockIsAuthored(block: CampaignBlock): boolean {
  const seed = defaultBlock(asString(block.type, "text"));
  return Object.keys(block).some((field) => {
    if (field === "type" || field === "id") return false;
    const value = asCSV(block[field]);
    return value.trim() !== "" && value !== asCSV(seed[field]);
  });
}

type CampaignContentBlocksSectionProps = {
  blocks: CampaignBlock[];
  aiBlockIndex: number | null;
  onAddBlock: (type: string) => void;
  onPatchBlock: (index: number, patch: CampaignBlock) => void;
  onRemoveBlock: (index: number) => void;
  onAI: (index: number) => void;
  onVideoConvert: (index: number) => void;
};

export function CampaignContentBlocksSection({
  blocks,
  aiBlockIndex,
  onAddBlock,
  onPatchBlock,
  onRemoveBlock,
  onAI,
  onVideoConvert,
}: CampaignContentBlocksSectionProps) {
  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-base font-semibold">Content blocks</h2>
          <p className="text-sm text-muted-foreground">
            {blocks.length} block{blocks.length === 1 ? "" : "s"} bound to this
            campaign.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {BLOCK_TYPES.map((type) => (
            <Button
              key={type}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onAddBlock(type)}
            >
              <Plus className="h-4 w-4" />
              {labelize(type)}
            </Button>
          ))}
        </div>
      </div>
      <div className="mt-4 grid gap-3">
        {blocks.length === 0 && (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            Add blocks or insert from assets and sections.
          </div>
        )}
        {blocks.map((block, index) => (
          <div
            key={`${asString(block.id, asString(block.type, "block"))}-${index}`}
            className="rounded-md border p-3"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <select
                  aria-label={`Block ${index + 1} type`}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  value={asString(block.type, "text")}
                  onChange={(e) =>
                    onPatchBlock(index, { type: e.target.value })
                  }
                >
                  {BLOCK_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {labelize(type)}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">
                  Block {index + 1}
                </span>
              </div>
              {/*
                The trash sits inches from the block-type select in the same
                row, and removal re-renders the body immediately with no undo
                path — the unsaved-changes guard only warns on navigation, it
                cannot put a block back. Authored blocks get the dialog; an
                untouched one stays a single click away from gone.
              */}
              {blockIsAuthored(block) ? (
                <ConfirmDialog
                  title="Remove this block?"
                  description={`Block ${index + 1} (${labelize(asString(block.type, "text"))}) and everything written into it will be removed from this campaign. This cannot be undone.`}
                  confirmLabel="Remove block"
                  onConfirm={() => onRemoveBlock(index)}
                  trigger={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove block ${index + 1}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  }
                />
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemoveBlock(index)}
                  aria-label={`Remove block ${index + 1}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            <BlockFields
              block={block}
              aiWorking={aiBlockIndex === index}
              onAI={() => onAI(index)}
              onVideoConvert={() => onVideoConvert(index)}
              onChange={(patch) => onPatchBlock(index, patch)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function BlockFields({
  block,
  aiWorking,
  onAI,
  onVideoConvert,
  onChange,
}: {
  block: CampaignBlock;
  aiWorking: boolean;
  onAI: () => void;
  onVideoConvert: () => void;
  onChange: (patch: CampaignBlock) => void;
}) {
  const type = asString(block.type, "text");
  const tools = (
    <div className="mb-3 flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAI}
        disabled={aiWorking}
      >
        <WandSparkles className="h-4 w-4" />
        {aiWorking ? "Writing..." : "Write with AI"}
      </Button>
      {type === "video" && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onVideoConvert}
          disabled={aiWorking}
        >
          Email video
        </Button>
      )}
    </div>
  );
  if (type === "image") {
    return (
      <>
        {tools}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-2 md:col-span-2">
            <FieldCaption>Image URL</FieldCaption>
            <Input
              value={asString(block.url, asString(block.image_url))}
              onChange={(e) => onChange({ url: e.target.value })}
            />
          </label>
          <label className="grid gap-2">
            <FieldCaption>Alt text</FieldCaption>
            <Input
              value={asString(block.alt_text)}
              onChange={(e) => onChange({ alt_text: e.target.value })}
            />
          </label>
          <label className="grid gap-2">
            <FieldCaption>Asset id</FieldCaption>
            <Input
              value={asString(block.asset_id)}
              onChange={(e) => onChange({ asset_id: e.target.value })}
            />
          </label>
        </div>
      </>
    );
  }
  if (type === "button") {
    return (
      <>
        {tools}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-2">
            <FieldCaption>Button label</FieldCaption>
            <Input
              value={asString(
                block.label,
                asString(block.content, "Read more"),
              )}
              onChange={(e) => onChange({ label: e.target.value })}
            />
          </label>
          <label className="grid gap-2">
            <FieldCaption>Button URL</FieldCaption>
            <Input
              value={asString(block.url)}
              onChange={(e) => onChange({ url: e.target.value })}
            />
          </label>
        </div>
      </>
    );
  }
  if (type === "product") {
    return (
      <>
        {tools}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-2">
            <FieldCaption>Product title</FieldCaption>
            <Input
              value={asString(block.title, asString(block.name))}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </label>
          <label className="grid gap-2">
            <FieldCaption>Price</FieldCaption>
            <Input
              value={asString(block.price)}
              onChange={(e) => onChange({ price: e.target.value })}
            />
          </label>
          <label className="grid gap-2">
            <FieldCaption>Product URL</FieldCaption>
            <Input
              value={asString(block.url)}
              onChange={(e) => onChange({ url: e.target.value })}
            />
          </label>
          <label className="grid gap-2">
            <FieldCaption>Image URL</FieldCaption>
            <Input
              value={asString(block.image_url, asString(block.url))}
              onChange={(e) => onChange({ image_url: e.target.value })}
            />
          </label>
        </div>
      </>
    );
  }
  if (type === "product_recommendations") {
    return (
      <>
        {tools}
        <div className="grid gap-3 md:grid-cols-3">
          <label className="grid gap-2 md:col-span-3">
            <FieldCaption>Section title</FieldCaption>
            <Input
              value={asString(block.title, "Recommended for you")}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </label>
          {[1, 2, 3].map((idx) => (
            <label key={idx} className="grid gap-2 rounded-md border p-3">
              <FieldCaption>Product {idx}</FieldCaption>
              <Input
                value={asString(block[`product_${idx}_title`])}
                placeholder="Product title"
                onChange={(e) =>
                  onChange({ [`product_${idx}_title`]: e.target.value })
                }
              />
              <Input
                value={asString(block[`product_${idx}_image`])}
                placeholder="Image URL"
                onChange={(e) =>
                  onChange({ [`product_${idx}_image`]: e.target.value })
                }
              />
              <Input
                value={asString(block[`product_${idx}_url`])}
                placeholder="Product URL"
                onChange={(e) =>
                  onChange({ [`product_${idx}_url`]: e.target.value })
                }
              />
            </label>
          ))}
        </div>
      </>
    );
  }
  if (type === "discount_code") {
    return (
      <>
        {tools}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-2">
            <FieldCaption>Code</FieldCaption>
            <Input
              value={asString(block.code, "SAVE10")}
              onChange={(e) => onChange({ code: e.target.value })}
            />
          </label>
          <label className="grid gap-2">
            <FieldCaption>Offer URL</FieldCaption>
            <Input
              value={asString(block.url)}
              onChange={(e) => onChange({ url: e.target.value })}
            />
          </label>
          <label className="grid gap-2 md:col-span-2">
            <FieldCaption>Description</FieldCaption>
            <Input
              value={asString(block.description)}
              onChange={(e) => onChange({ description: e.target.value })}
            />
          </label>
        </div>
      </>
    );
  }
  if (type === "survey") {
    return (
      <>
        {tools}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-2">
            <FieldCaption>Question</FieldCaption>
            <Input
              value={asString(block.question, "What did you think?")}
              onChange={(e) => onChange({ question: e.target.value })}
            />
          </label>
          <label className="grid gap-2">
            <FieldCaption>Survey URL</FieldCaption>
            <Input
              value={asString(block.url)}
              onChange={(e) => onChange({ url: e.target.value })}
            />
          </label>
          <label className="grid gap-2 md:col-span-2">
            <FieldCaption>Choices</FieldCaption>
            <Textarea
              value={asCSV(block.choices, "Great, Okay, Not for me")}
              onChange={(e) => onChange({ choices: e.target.value })}
            />
          </label>
        </div>
      </>
    );
  }
  if (type === "social_follow" || type === "social_share") {
    return (
      <>
        {tools}
        <div className="grid gap-3 md:grid-cols-2">
          {type === "social_share" ? (
            <>
              <label className="grid gap-2">
                <FieldCaption>Prompt</FieldCaption>
                <Input
                  value={asString(block.text, "Share this")}
                  onChange={(e) => onChange({ text: e.target.value })}
                />
              </label>
              <label className="grid gap-2">
                <FieldCaption>Share URL</FieldCaption>
                <Input
                  value={asString(block.share_url)}
                  onChange={(e) => onChange({ share_url: e.target.value })}
                />
              </label>
            </>
          ) : (
            ["facebook_url", "instagram_url", "linkedin_url", "x_url"].map(
              (key) => (
                <label key={key} className="grid gap-2">
                  <FieldCaption>{labelize(key)}</FieldCaption>
                  <Input
                    value={asString(block[key])}
                    onChange={(e) => onChange({ [key]: e.target.value })}
                  />
                </label>
              ),
            )
          )}
        </div>
      </>
    );
  }
  if (type === "rss") {
    return (
      <>
        {tools}
        <div className="grid gap-3 md:grid-cols-3">
          <label className="grid gap-2">
            <FieldCaption>Title</FieldCaption>
            <Input
              value={asString(block.title, "Latest posts")}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </label>
          <label className="grid gap-2">
            <FieldCaption>Feed URL</FieldCaption>
            <Input
              value={asString(block.feed_url)}
              onChange={(e) => onChange({ feed_url: e.target.value })}
            />
          </label>
          <label className="grid gap-2">
            <FieldCaption>Count</FieldCaption>
            <Input
              type="number"
              min={1}
              max={10}
              value={asString(block.count, "3")}
              onChange={(e) => onChange({ count: e.target.value })}
            />
          </label>
        </div>
      </>
    );
  }
  if (type === "video") {
    return (
      <>
        {tools}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-2">
            <FieldCaption>Video URL</FieldCaption>
            <Input
              value={asString(block.video_url, asString(block.url))}
              onChange={(e) => onChange({ video_url: e.target.value })}
            />
          </label>
          <label className="grid gap-2">
            <FieldCaption>Thumbnail URL</FieldCaption>
            <Input
              value={asString(block.thumbnail_url)}
              onChange={(e) => onChange({ thumbnail_url: e.target.value })}
            />
          </label>
          <label className="grid gap-2 md:col-span-2">
            <FieldCaption>Title</FieldCaption>
            <Input
              value={asString(block.title, "Watch video")}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </label>
        </div>
      </>
    );
  }
  if (type === "dynamic_content" || type === "conditional_content") {
    return (
      <>
        {tools}
        <div className="grid gap-3">
          <label className="grid gap-2">
            <FieldCaption>Condition</FieldCaption>
            <Input
              value={asString(
                block.condition,
                type === "conditional_content" ? "FNAME" : "is_vip",
              )}
              onChange={(e) => onChange({ condition: e.target.value })}
            />
          </label>
          <label className="grid gap-2">
            <FieldCaption>Content</FieldCaption>
            <Textarea
              className="min-h-[100px]"
              value={asString(block.content)}
              onChange={(e) => onChange({ content: e.target.value })}
            />
          </label>
          <label className="grid gap-2">
            <FieldCaption>Fallback</FieldCaption>
            <Textarea
              className="min-h-[100px]"
              value={asString(block.fallback)}
              onChange={(e) => onChange({ fallback: e.target.value })}
            />
          </label>
        </div>
      </>
    );
  }
  if (type === "section") {
    return (
      <>
        {tools}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-2">
            <FieldCaption>Section id</FieldCaption>
            <Input
              value={asString(block.section_id)}
              onChange={(e) => onChange({ section_id: e.target.value })}
            />
          </label>
          <label className="grid gap-2">
            <FieldCaption>Section name</FieldCaption>
            <Input
              value={asString(block.name)}
              onChange={(e) => onChange({ name: e.target.value })}
            />
          </label>
          <label className="grid gap-2 md:col-span-2">
            <FieldCaption>Section content</FieldCaption>
            <Textarea
              className="min-h-[120px]"
              value={asString(block.content)}
              onChange={(e) => onChange({ content: e.target.value })}
            />
          </label>
        </div>
      </>
    );
  }
  return (
    <>
      {tools}
      <label className="grid gap-2">
        <FieldCaption>
          {type === "heading" ? "Heading" : "Content"}
        </FieldCaption>
        <Textarea
          className={type === "heading" ? "min-h-[80px]" : "min-h-[120px]"}
          value={asString(block.content, asString(block.body))}
          onChange={(e) => onChange({ content: e.target.value })}
        />
      </label>
    </>
  );
}

function FieldCaption({ children }: { children: ReactNode }) {
  return <span className="text-sm font-medium leading-none">{children}</span>;
}
