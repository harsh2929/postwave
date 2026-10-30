import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type Tag,
  type TagSubscriber,
  type TagUsage,
  api,
} from "../../lib/api-client";
import { queueReceiptMessage } from "../../lib/api/result";
import { useSlideoverBehavior } from "../../hooks/useSlideoverBehavior";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { toast } from "../Toast";
import { limitRunes, runeLength } from "../../pages/tags/tagPageModel";
import { TagDetailDangerZone, TagDetailHeader } from "./TagDetailChrome";
import { TagMembershipChart } from "./TagMembershipChart";
import { TagSubscribersSection } from "./TagSubscribersSection";
import { isTag, isTagSubscriber } from "./tagRemoteValidation";

const SUBSCRIBERS_LOAD_ERROR =
  "Subscribers for this tag could not be verified. Retry to load them.";

interface Props {
  tag: Tag;
  usage?: TagUsage;
  usageAvailable: boolean;
  onClose: () => void;
  onUpdated: (next: Tag) => void;
  onConflict: () => void;
  canMutate: boolean;
}

export function TagDetailSlideover({
  tag,
  usage,
  usageAvailable,
  onClose,
  onUpdated,
  onConflict,
  canMutate,
}: Props): ReactElement {
  const titleId = useId();
  const descriptionId = useId();
  const [verifiedSubscribers, setVerifiedSubscribers] = useState<{
    tagName: string;
    items: TagSubscriber[];
  } | null>(null);
  const [subsLoading, setSubsLoading] = useState(true);
  const [subsError, setSubsError] = useState<string | null>(null);
  const [draftDesc, setDraftDesc] = useState(tag.description ?? "");
  const [savingDesc, setSavingDesc] = useState(false);
  const subscriberRequestRef = useRef(0);
  const descriptionRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const subs =
    verifiedSubscribers?.tagName === tag.name
      ? verifiedSubscribers.items
      : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      subscriberRequestRef.current += 1;
      descriptionRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    setDraftDesc(tag.description ?? "");
    descriptionRequestRef.current += 1;
    setSavingDesc(false);
  }, [tag.id]);

  const loadSubscribers = useCallback(async (): Promise<void> => {
    const requestId = ++subscriberRequestRef.current;
    setSubsLoading(true);
    setSubsError(null);
    try {
      const result = await api.listSubscribersWithTag(tag.name, 50);
      if (requestId !== subscriberRequestRef.current) return;
      const items = result.data?.items;
      if (
        result.error ||
        result.data?.tag !== tag.name ||
        !Array.isArray(items) ||
        !items.every(isTagSubscriber) ||
        new Set(items.map((item) => item.id)).size !== items.length
      ) {
        setSubsError(SUBSCRIBERS_LOAD_ERROR);
        return;
      }
      setVerifiedSubscribers({ tagName: tag.name, items });
    } catch {
      if (requestId === subscriberRequestRef.current) {
        setSubsError(SUBSCRIBERS_LOAD_ERROR);
      }
    } finally {
      if (requestId === subscriberRequestRef.current) setSubsLoading(false);
    }
  }, [tag.name]);

  useEffect(() => {
    void loadSubscribers();
    return () => {
      subscriberRequestRef.current += 1;
    };
  }, [loadSubscribers]);

  useSlideoverBehavior({ open: true, onClose });

  const saveDesc = useCallback(async (): Promise<void> => {
    const current = tag.description ?? "";
    if (draftDesc === current || savingDesc) return;
    const targetId = tag.id;
    const requestId = ++descriptionRequestRef.current;
    setSavingDesc(true);
    try {
      const result = await api.updateTag(
        targetId,
        { description: draftDesc },
        tag.etag ?? "",
      );
      if (!mountedRef.current || requestId !== descriptionRequestRef.current)
        return;
      if (result.error) {
        if (result.error.status === 412) {
          toast.error(
            "This tag changed elsewhere. Your description draft was preserved while the latest version reloads.",
          );
          onConflict();
        } else {
          toast.error("The tag description could not be saved. Try again.");
        }
        return;
      }
      if (result.queued) {
        onUpdated({ ...tag, description: draftDesc });
        toast.info({
          message: queueReceiptMessage(result.receipt),
          detail:
            "This panel shows the local description until server confirmation.",
        });
        return;
      }
      if (!isTag(result.data) || result.data.id !== targetId) {
        toast.error({
          message: "The save response could not be verified.",
          detail: "Refresh the catalogue before editing this tag again.",
        });
        return;
      }
      onUpdated(result.data);
      toast.success("Description saved");
    } catch {
      if (mountedRef.current && requestId === descriptionRequestRef.current) {
        toast.error("The tag description could not be saved. Try again.");
      }
    } finally {
      if (mountedRef.current && requestId === descriptionRequestRef.current) {
        setSavingDesc(false);
      }
    }
  }, [draftDesc, onConflict, onUpdated, savingDesc, tag]);

  const descriptionDirty = draftDesc !== (tag.description ?? "");
  useEffect(() => {
    if (!descriptionDirty && !savingDesc) return;
    return registerLifecycleGuard({
      id: `tag-detail-${tag.id}`,
      label: "Tag description changes",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : savingDesc
            ? {
                level: "blocking",
                detail: "The tag description is still saving.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail: "The tag description has unsaved changes.",
              },
      prepare: savingDesc ? undefined : saveDesc,
      discard: () => {
        setDraftDesc(tag.description ?? "");
        onClose();
      },
    });
  }, [
    descriptionDirty,
    onClose,
    saveDesc,
    savingDesc,
    tag.description,
    tag.id,
  ]);

  const count = usageAvailable ? (usage?.subscribers ?? 0) : null;
  const descriptionLength = runeLength(draftDesc);

  return (
    <>
      <div
        className="slideover-overlay"
        onClick={onClose}
        role="presentation"
      />
      <aside
        className="slideover tags-detail-slideover"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <button
          type="button"
          className="slideover-close"
          aria-label={`Close ${tag.name}`}
          onClick={onClose}
        >
          ✕
        </button>
        <TagDetailHeader
          tag={tag}
          count={count}
          titleId={titleId}
          descriptionId={descriptionId}
        />

        <section
          className="tag-detail-section"
          aria-labelledby="tag-description-title"
        >
          <h3 id="tag-description-title" className="field-label">
            Description
          </h3>
          <textarea
            className="input"
            rows={4}
            value={draftDesc}
            onChange={(event) =>
              setDraftDesc(limitRunes(event.target.value, 1_024))
            }
            placeholder="What does this tag mean? Who should get it?"
            disabled={!canMutate || savingDesc}
          />
          <div className="tag-description-actions">
            <span className="field-help">
              {descriptionLength.toLocaleString()} / 1,024
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!descriptionDirty || savingDesc}
              onClick={() => setDraftDesc(tag.description ?? "")}
            >
              Reset
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!descriptionDirty || savingDesc || !canMutate}
              onClick={() => void saveDesc()}
            >
              {savingDesc ? "Saving…" : "Save description"}
            </button>
          </div>
        </section>

        <section className="tag-detail-section" aria-label="Membership history">
          <TagMembershipChart tagId={tag.id} />
        </section>
        <TagSubscribersSection
          tagName={tag.name}
          count={count}
          subscribers={subs}
          loading={subsLoading}
          error={subsError}
          onRetry={() => void loadSubscribers()}
        />
        <TagDetailDangerZone />
      </aside>
    </>
  );
}
