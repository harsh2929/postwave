// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { ImageIcon, Layers3 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  convertVideoForEmail,
  listCompatResources,
  runInlineAI,
  type CampaignAsset,
  type CampaignSection,
} from "@/lib/mailchimp-compat-api";
import {
  renderCampaignBlocksToHTML,
  renderCampaignBlocksToText,
} from "@/lib/campaign-block-renderer";

import { CampaignContentBlocksSection } from "./campaign-content-blocks-section";
import {
  asString,
  blockSummary,
  defaultBlock,
  type CampaignBlock,
} from "./campaign-detail-helpers";

type CompatResourceLoadState<T> = {
  items: T[];
  status: "loading" | "ready" | "error";
};

function useCompatResourceList<T>(
  resource: "assets" | "sections",
): CompatResourceLoadState<T> & { retry: () => void } {
  const [requestVersion, setRequestVersion] = useState(0);
  const [state, setState] = useState<CompatResourceLoadState<T>>({
    items: [],
    status: "loading",
  });

  useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, status: "loading" }));
    void listCompatResources<T>(resource)
      .then((items) => {
        if (active) setState({ items, status: "ready" });
      })
      .catch(() => {
        if (active) {
          setState((current) => ({ ...current, status: "error" }));
        }
      });
    return () => {
      active = false;
    };
  }, [requestVersion, resource]);

  return {
    ...state,
    retry: () => setRequestVersion((version) => version + 1),
  };
}

export interface CampaignContentUpdate {
  blocks: CampaignBlock[];
  bodyHtml: string;
  plainText: string;
}

export type CampaignContentEditorProps = {
  campaignId: string;
  campaignName: string;
  campaignSubject: string;
  blocks: CampaignBlock[];
  selectedSectionIds: string[];
  onBlocksChange: (update: CampaignContentUpdate) => void;
  onReusableSectionIdsChange: (ids: string[]) => void;
};

const ContentStudioPanel = dynamic(
  () =>
    import("@/components/mailchimp-parity/content-studio-panel").then(
      (mod) => ({
        default: mod.ContentStudioPanel,
      }),
    ),
  {
    loading: () => <ContentEditorSkeleton title="Content studio" />,
  },
);

export function CampaignContentEditor({
  campaignId,
  campaignName,
  campaignSubject,
  blocks,
  selectedSectionIds,
  onBlocksChange,
  onReusableSectionIdsChange,
}: CampaignContentEditorProps) {
  const assetsResource = useCompatResourceList<CampaignAsset>("assets");
  const sectionsResource = useCompatResourceList<CampaignSection>("sections");
  const assets = assetsResource.items;
  const sections = sectionsResource.items;
  const [aiBlockIndex, setAiBlockIndex] = useState<number | null>(null);

  const commitBlocks = (nextBlocks: CampaignBlock[]) => {
    onBlocksChange({
      blocks: nextBlocks,
      bodyHtml: renderCampaignBlocksToHTML(nextBlocks),
      plainText: renderCampaignBlocksToText(nextBlocks),
    });
  };

  const patchBlock = (index: number, patch: CampaignBlock) => {
    commitBlocks(
      blocks.map((block, i) => (i === index ? { ...block, ...patch } : block)),
    );
  };

  const addBlock = (type: string, patch: CampaignBlock = {}) => {
    commitBlocks([...blocks, defaultBlock(type, patch)]);
  };

  const removeBlock = (index: number) => {
    commitBlocks(blocks.filter((_, i) => i !== index));
  };

  const improveBlockWithAI = async (index: number) => {
    const block = blocks[index];
    if (!block) return;
    setAiBlockIndex(index);
    try {
      const source =
        asString(block.content) ||
        asString(block.body) ||
        asString(block.title) ||
        asString(block.label) ||
        campaignSubject;
      const res = await runInlineAI({
        channel: "email",
        mode: asString(block.type) === "heading" ? "subject" : "rewrite",
        text: source,
        context: { campaign_id: campaignId, block_type: block.type },
      });
      if (asString(block.type) === "heading") {
        patchBlock(index, { content: res.text });
      } else {
        patchBlock(index, { content: res.text, body: res.text });
      }
      toast.success("AI draft applied.");
    } catch {
      toast.error("AI draft failed.");
    } finally {
      setAiBlockIndex(null);
    }
  };

  const convertVideoBlock = async (index: number) => {
    const block = blocks[index];
    if (!block) return;
    const url = asString(block.video_url, asString(block.url));
    if (!url.trim()) {
      toast.error("Add a video URL first.");
      return;
    }
    setAiBlockIndex(index);
    try {
      const converted = await convertVideoForEmail({
        url,
        title: asString(block.title, campaignName),
        thumbnail_url: asString(block.thumbnail_url),
      });
      patchBlock(index, {
        video_url: converted.url,
        thumbnail_url: converted.thumbnail_url,
        title: asString(block.title, "Watch video"),
        merge_tag: converted.merge_tag,
        content: converted.email_html,
      });
      toast.success("Video converted for email.");
    } catch {
      toast.error("Video conversion failed.");
    } finally {
      setAiBlockIndex(null);
    }
  };

  const setReusableSectionIds = (ids: string[]) => {
    onReusableSectionIdsChange(ids);
  };

  const toggleSection = (sectionId: string) => {
    setReusableSectionIds(
      selectedSectionIds.includes(sectionId)
        ? selectedSectionIds.filter((id) => id !== sectionId)
        : [...selectedSectionIds, sectionId],
    );
  };

  const insertSection = (section: CampaignSection) => {
    if (!selectedSectionIds.includes(section.id)) {
      setReusableSectionIds([...selectedSectionIds, section.id]);
    }
    addBlock("section", {
      section_id: section.id,
      name: section.name,
      content: section.html || blockSummary(section.blocks),
    });
  };

  const insertAsset = (asset: CampaignAsset) => {
    addBlock(asset.asset_type === "product" ? "product" : "image", {
      asset_id: asset.id,
      name: asset.name,
      url: asset.url,
      image_url: asset.url,
      alt_text: asset.alt_text || asset.name,
      title: asset.name,
    });
  };

  return (
    <>
      <ContentStudioPanel />

      <CampaignContentBlocksSection
        blocks={blocks}
        aiBlockIndex={aiBlockIndex}
        onAddBlock={addBlock}
        onPatchBlock={patchBlock}
        onRemoveBlock={removeBlock}
        onAI={(index) => void improveBlockWithAI(index)}
        onVideoConvert={(index) => void convertVideoBlock(index)}
      />

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-md border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <ImageIcon className="h-4 w-4" />
            <h2 className="text-base font-semibold">Assets</h2>
          </div>
          <div className="grid gap-2">
            {assetsResource.status === "loading" && assets.length === 0 ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading campaign assets…
              </p>
            ) : null}
            {assetsResource.status === "error" ? (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
              >
                <p>Could not load campaign assets.</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={assetsResource.retry}
                >
                  Retry
                </Button>
              </div>
            ) : null}
            {assetsResource.status === "ready" && assets.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No campaign assets have been created yet.
              </p>
            ) : null}
            {assets.slice(0, 8).map((asset) => (
              <div
                key={asset.id}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {asset.name}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {asset.asset_type} - {asset.url}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => insertAsset(asset)}
                >
                  Insert
                </Button>
              </div>
            ))}
            {assets.length > 8 && (
              <p className="text-xs text-muted-foreground">
                Showing 8 of {assets.length}. Manage the rest in the asset
                library.
              </p>
            )}
          </div>
        </div>

        <div className="rounded-md border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <Layers3 className="h-4 w-4" />
            <h2 className="text-base font-semibold">Reusable sections</h2>
          </div>
          <div className="grid gap-2">
            {sectionsResource.status === "loading" && sections.length === 0 ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading reusable sections…
              </p>
            ) : null}
            {sectionsResource.status === "error" ? (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
              >
                <p>Could not load reusable sections.</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={sectionsResource.retry}
                >
                  Retry
                </Button>
              </div>
            ) : null}
            {sectionsResource.status === "ready" && sections.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No reusable sections have been saved yet.
              </p>
            ) : null}
            {sections.slice(0, 8).map((section) => (
              <div key={section.id} className="rounded-md border p-3">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selectedSectionIds.includes(section.id)}
                    onChange={() => toggleSection(section.id)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {section.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {section.category || "general"}
                    </span>
                  </span>
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => insertSection(section)}
                >
                  Insert section
                </Button>
              </div>
            ))}
            {sections.length > 8 && (
              <p className="text-xs text-muted-foreground">
                Showing 8 of {sections.length} saved sections.
              </p>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

function ContentEditorSkeleton({ title }: { title: string }) {
  return (
    <section
      aria-label={`${title} loading`}
      className="rounded-md border bg-card p-4"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="h-5 w-44 rounded bg-muted" />
          <div className="h-4 w-72 max-w-full rounded bg-muted" />
        </div>
        <div className="h-8 w-32 rounded bg-muted" />
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="h-20 rounded-md border bg-background" />
        ))}
      </div>
    </section>
  );
}
