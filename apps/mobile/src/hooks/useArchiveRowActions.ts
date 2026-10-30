/**
 * hooks/useArchiveRowActions.ts — the two verbs an archive row offers.
 *
 * Extracted from `app/(tabs)/archive.tsx` when pin/unpin shipped and the screen
 * crossed its line ceiling. The seam is not arbitrary: the screen owns paging,
 * search, provenance and the RSS affordance; these two own a MUTATION plus the
 * confirmation policy around it, and that policy is the interesting part.
 *
 * ── WHY UNPUBLISH CONFIRMS AND PIN DOES NOT ────────────────────────────────
 * Unpublish is irreversible from this platform. Re-publishing needs a slug,
 * excerpt and the SEO fields the phone never collected — `AdminPublish`
 * requires a validated `PublishInput` and answers 422 `slug_required` without
 * one — so there is no undo to offer and the cost of a mis-tap is a 404 for
 * every subscriber holding the link. That earns a confirm sheet naming the
 * consequence.
 *
 * Pin is reversible by the very control that set it, and the server is
 * idempotent about it (`views.go:317`). A dialog there would make the
 * reversible act feel heavier than the destructive one, which is exactly
 * backwards.
 *
 * ── NO usePublishArchiveIssue ──────────────────────────────────────────────
 * There is deliberately no third verb here; see the note in `useArchiveOps`.
 * The hook that used to exist could never have worked — it posted no body to an
 * endpoint that requires one — and was held in place by a contract test
 * asserting only that the symbol existed.
 */
import { useCallback } from "react";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import {
  usePinArchiveIssue,
  useUnpinArchiveIssue,
  useUnpublishArchiveIssue,
  type ArchiveIssue,
} from "@/hooks/useArchiveOps";
import { haptics } from "@/lib/haptics";

export interface ArchiveRowActions {
  onUnpublish: (row: ArchiveIssue) => Promise<void>;
  onTogglePin: (row: ArchiveIssue) => Promise<void>;
  /** Lets the screen drop a preview whose issue just stopped being public. */
  onUnpublished: (slug: string) => void;
}

export function useArchiveRowActions(options?: {
  onUnpublished?: (slug: string) => void;
}): ArchiveRowActions {
  const confirm = useConfirm();
  const { toast } = useToast();
  const unpublish = useUnpublishArchiveIssue();
  const pin = usePinArchiveIssue();
  const unpin = useUnpinArchiveIssue();
  const notifyUnpublished = options?.onUnpublished;

  const onUnpublish = useCallback(
    async (row: ArchiveIssue) => {
      const title = row.subject || row.slug;
      const ok = await confirm({
        title: "Unpublish this issue?",
        message: `"${title}" will stop resolving on your public archive and will drop out of the RSS feed.`,
        consequence:
          "Anyone holding the link — including subscribers who already received it — gets a 404 from now on.",
        confirmLabel: "Unpublish",
        cancelLabel: "Keep published",
        destructive: true,
      });
      if (!ok) return;
      try {
        await unpublish.mutateAsync({
          campaignId: row.campaignId,
          slug: row.slug,
        });
        haptics.success();
        // Deliberately NOT a toast-with-undo: re-publishing needs the slug,
        // excerpt and SEO fields the phone never collected, so an "Undo" here
        // could only ever half-restore the issue.
        toast({ kind: "success", message: `"${title}" is no longer public.` });
        notifyUnpublished?.(row.slug);
      } catch (e: unknown) {
        haptics.error();
        toast({
          kind: "error",
          message:
            e instanceof Error
              ? e.message
              : "Couldn't unpublish this issue. Try again.",
        });
      }
    },
    [confirm, notifyUnpublished, toast, unpublish],
  );

  const onTogglePin = useCallback(
    async (row: ArchiveIssue) => {
      const title = row.subject || row.slug;
      const wasPinned = row.pinned;
      try {
        await (wasPinned ? unpin : pin).mutateAsync({
          campaignId: row.campaignId,
          slug: row.slug,
        });
        haptics.success();
        toast({
          kind: "success",
          message: wasPinned
            ? `"${title}" is no longer featured.`
            : `"${title}" is featured at the top of your archive.`,
        });
      } catch (e: unknown) {
        haptics.error();
        toast({
          kind: "error",
          message:
            e instanceof Error
              ? e.message
              : `Couldn't ${wasPinned ? "unpin" : "pin"} this issue. Try again.`,
        });
      }
    },
    [pin, toast, unpin],
  );

  return {
    onUnpublish,
    onTogglePin,
    onUnpublished: (slug: string) => notifyUnpublished?.(slug),
  };
}
