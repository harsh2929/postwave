/**
 * hooks/useTemplateCompareShortlist.ts — the long-press shortlist behind
 * side-by-side compare (desktop parity: TemplateComparePanel's selection;
 * the mobile pattern is CampaignCompareSheet).
 *
 * SELECTION IS NOT THE READ. `ids` grows and shrinks with every long-press
 * and nothing is fetched; `open` is what arms `useTemplateCompare` — pressing
 * Compare is the read. The cap (lib/templateDiscovery.TEMPLATE_COMPARE_MAX,
 * the server's own bound in normalizeCompareIdentifiers) is refused BEFORE
 * any request, with a stated reason. The refusal is computed OUTSIDE the
 * state updater: an updater must stay pure, and the toast is a side effect.
 */
import { useCallback, useState } from "react";

import { useToast } from "@/components/Toast";
import type { MobileTemplate } from "@/lib/templateCatalog";
import { toggleCompareId } from "@/lib/templateDiscovery";

export interface TemplateCompareShortlist {
  ids: string[];
  /** True while the compare sheet is up — the only time the read is armed. */
  open: boolean;
  toggle: (template: MobileTemplate) => void;
  clear: () => void;
  openSheet: () => void;
  closeSheet: () => void;
}

export function useTemplateCompareShortlist(): TemplateCompareShortlist {
  const { toast } = useToast();
  const [ids, setIds] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  const toggle = useCallback(
    (template: MobileTemplate) => {
      const next = toggleCompareId(ids, template.id);
      if (next.blockReason) {
        toast({ kind: "warning", message: next.blockReason });
        return;
      }
      setIds(next.ids);
    },
    [ids, toast],
  );
  const clear = useCallback(() => setIds([]), []);
  const openSheet = useCallback(() => setOpen(true), []);
  const closeSheet = useCallback(() => setOpen(false), []);

  return { ids, open, toggle, clear, openSheet, closeSheet };
}
