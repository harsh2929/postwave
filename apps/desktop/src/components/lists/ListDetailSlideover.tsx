/**
 * ListDetailSlideover — tabbed right-side workspace for one list.
 *
 * The old version rendered health, members, and webhooks in one long
 * column while the richer tab components sat unused on disk. This shell
 * keeps the existing header/actions and delegates each body area to the
 * dedicated tabs.
 */

import { type ReactElement, useEffect, useMemo, useState } from "react";

import { useSlideoverBehavior } from "../../hooks/useSlideoverBehavior";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import { api, type List, type ListHealthResult } from "../../lib/api-client";
import { fmtDate } from "../../lib/format-date";
import { useCanWrite } from "../../lib/store";
import { ConfirmModal } from "../ConfirmModal";
import { ActivityTab } from "./tabs/ActivityTab";
import { AnalyticsTab } from "./tabs/AnalyticsTab";
import { AutomationsTab } from "./tabs/AutomationsTab";
import { FormsTab } from "./tabs/FormsTab";
import { InboxRealityTab } from "./tabs/InboxRealityTab";
import { MembersTab } from "./tabs/MembersTab";
import { MergeFieldsTab } from "./tabs/MergeFieldsTab";
import { OverviewTab } from "./tabs/OverviewTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { SuppressionTab } from "./tabs/SuppressionTab";
import { WebhooksTab } from "./tabs/WebhooksTab";

interface Props {
  list: List;
  /** Called when the slideover wants to close itself (X / ESC / overlay). */
  onClose: () => void;
  /** Called when the user clicks the inline Edit button. */
  onEdit: (list: List) => void;
  /** Called when the user clicks the inline Delete button. */
  onDelete: (list: List) => void;
}

type ListTab =
  | "overview"
  | "members"
  | "settings"
  | "analytics"
  | "activity"
  | "forms"
  | "automations"
  | "webhooks"
  | "suppression"
  | "inboxReality"
  | "mergeFields";

const TABS: Array<{ id: ListTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "members", label: "Members" },
  { id: "settings", label: "Settings" },
  { id: "analytics", label: "Analytics" },
  { id: "activity", label: "Activity" },
  { id: "forms", label: "Forms" },
  { id: "automations", label: "Automations" },
  { id: "webhooks", label: "Webhooks" },
  { id: "suppression", label: "Suppression" },
  // Full-surface wiring #46: GET /lists/{id}/inbox-reality.
  { id: "inboxReality", label: "Inbox reality" },
  { id: "mergeFields", label: "Merge fields" },
];

const LIST_SLIDEOVER_STYLES = `
  .pw-list-slideover {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(920px, 100vw);
    background: var(--pw-bg-elev);
    border-left: 1px solid var(--pw-border);
    z-index: 91;
    display: flex;
    flex-direction: column;
    padding-top: calc(var(--pw-titlebar-h, 28px) + 18px);
    overflow: hidden;
  }
  .pw-list-slideover-overlay {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--pw-shadow-color) 40%, transparent);
    z-index: 90;
  }
  .pw-list-slideover-close {
    position: absolute;
    top: calc(var(--pw-titlebar-h, 28px) + 8px);
    right: 10px;
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    border-radius: 4px;
    color: var(--pw-fg-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 16px;
  }
  .pw-list-slideover-close:hover {
    background: var(--pw-bg-elev-2);
    color: var(--pw-fg);
  }
  .pw-list-slideover-header {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 0 18px 12px;
    border-bottom: 1px solid var(--pw-border);
  }
  .pw-list-slideover-title-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 14px;
    align-items: start;
    padding-right: 30px;
  }
  .pw-list-slideover-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .pw-list-slideover-tabbar {
    display: flex;
    gap: 4px;
    align-items: center;
    overflow-x: auto;
    scrollbar-gutter: stable;
    padding-bottom: 2px;
  }
  .pw-list-slideover-tab {
    border: 1px solid transparent;
    background: transparent;
    color: var(--pw-fg-muted);
    border-radius: 4px;
    height: 30px;
    padding: 0 9px;
    font-size: 12px;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .pw-list-slideover-tab:hover {
    background: var(--pw-bg-elev-2);
    color: var(--pw-fg);
  }
  .pw-list-slideover-tab.is-active {
    background: color-mix(in srgb, var(--pw-accent) 12%, transparent);
    border-color: color-mix(in srgb, var(--pw-accent) 36%, transparent);
    color: var(--pw-fg);
  }
  .pw-list-slideover-tab-count {
    color: var(--pw-fg-subtle);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  .pw-list-slideover-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 14px 18px 18px;
  }
`;

interface ListTabBodyProps {
  activeTab: ListTab;
  list: List;
  health: ListHealthResult | null | undefined;
  onMembersTotalChange: (total: number) => void;
  onListUpdated: (next: List) => void;
  onSettingsDraftStateChange: (state: SettingsDraftState) => void;
}

function ListTabBody({
  activeTab,
  list,
  health,
  onMembersTotalChange,
  onListUpdated,
  onSettingsDraftStateChange,
}: ListTabBodyProps): ReactElement {
  switch (activeTab) {
    case "overview":
      return <OverviewTab list={list} health={health} />;
    case "members":
      return <MembersTab list={list} onTotalChange={onMembersTotalChange} />;
    case "settings":
      return (
        <SettingsTab
          list={list}
          onUpdated={onListUpdated}
          onDraftStateChange={onSettingsDraftStateChange}
        />
      );
    case "analytics":
      return <AnalyticsTab list={list} />;
    case "activity":
      return <ActivityTab list={list} />;
    case "forms":
      return <FormsTab list={list} />;
    case "automations":
      return <AutomationsTab list={list} />;
    case "webhooks":
      return <WebhooksTab list={list} />;
    case "suppression":
      return <SuppressionTab list={list} />;
    case "inboxReality":
      return <InboxRealityTab list={list} />;
    case "mergeFields":
      return <MergeFieldsTab list={list} />;
  }
}

interface SettingsDraftState {
  dirty: boolean;
  operationActive: boolean;
}

type PendingLocalTransition =
  | { kind: "close" }
  | { kind: "tab"; tab: ListTab }
  | { kind: "edit" }
  | { kind: "delete" };

function useListLocalDraftTransitions({
  activeTab,
  setActiveTab,
  list,
  onClose,
  onEdit,
  onDelete,
}: {
  activeTab: ListTab;
  setActiveTab: (tab: ListTab) => void;
  list: List;
  onClose: () => void;
  onEdit: (list: List) => void;
  onDelete: (list: List) => void;
}) {
  const [settingsState, setSettingsState] = useState<SettingsDraftState>({
    dirty: false,
    operationActive: false,
  });
  const [pending, setPending] = useState<PendingLocalTransition | null>(null);
  const settingsActive = activeTab === "settings";
  const request = (transition: PendingLocalTransition): void => {
    if (settingsActive && settingsState.operationActive) return;
    if (settingsActive && settingsState.dirty) {
      setPending(transition);
      return;
    }
    execute(transition);
  };
  const execute = (transition: PendingLocalTransition): void => {
    if (transition.kind === "close") onClose();
    else if (transition.kind === "tab") setActiveTab(transition.tab);
    else if (transition.kind === "edit") onEdit(list);
    else onDelete(list);
  };
  const discardAndContinue = (): void => {
    const transition = pending;
    setPending(null);
    if (transition) execute(transition);
  };
  return {
    blocked: settingsActive && settingsState.operationActive,
    confirmOpen: pending !== null,
    setSettingsState,
    requestClose: () => request({ kind: "close" }),
    requestTab: (tab: ListTab) => request({ kind: "tab", tab }),
    requestEdit: () => request({ kind: "edit" }),
    requestDelete: () => request({ kind: "delete" }),
    cancelDiscard: () => setPending(null),
    discardAndContinue,
  };
}

export function ListDetailSlideover({
  list,
  onClose,
  onEdit,
  onDelete,
}: Props): ReactElement {
  const canMutate = useCanWrite();
  const [activeTab, setActiveTab] = useState<ListTab>("overview");
  const [currentList, setCurrentList] = useState<List>(list);
  const [health, setHealth] = useState<ListHealthResult | null | undefined>(
    undefined,
  );
  const [membersTotal, setMembersTotal] = useState<number | null>(
    list.subscriber_count ?? null,
  );
  const localTransitions = useListLocalDraftTransitions({
    activeTab,
    setActiveTab,
    list: currentList,
    onClose,
    onEdit,
    onDelete,
  });
  const tabs = useTabsInteraction({
    activation: "manual",
    value: activeTab,
    items: TABS.map((tab) => ({
      value: tab.id,
      disabled: localTransitions.blocked && activeTab !== tab.id,
    })),
    onChange: localTransitions.requestTab,
  });

  useSlideoverBehavior({ open: true, onClose: localTransitions.requestClose });

  useEffect(() => {
    setCurrentList(list);
    setMembersTotal(list.subscriber_count ?? null);
    setActiveTab("overview");
  }, [list]);

  useEffect(() => {
    let cancelled = false;
    if (!currentList.name.trim()) {
      setHealth(null);
      return;
    }
    setHealth(undefined);
    void api
      .getListHealth({ tag: currentList.name, windowDays: 90 })
      .then((res) => {
        if (cancelled) return;
        const data = res.error ? null : (res.data ?? null);
        // The backend's tag-based approximation returns a fabricated A/100
        // for zero matching subscribers. Keep the slideover consistent with
        // the Lists table and show that case as "no signal", not healthy.
        setHealth(data && data.total_subscribers > 0 ? data : null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentList.id, currentList.name]);

  const isPublic = (currentList.type ?? "private").toLowerCase() === "public";
  const isDouble = (currentList.optin ?? "single").toLowerCase() === "double";

  const subscriberCount = membersTotal ?? currentList.subscriber_count ?? 0;

  const tabCounts = useMemo<Partial<Record<ListTab, string>>>(() => {
    if (!Number.isFinite(subscriberCount) || subscriberCount <= 0) return {};
    return {
      members: subscriberCount.toLocaleString(),
    };
  }, [subscriberCount]);

  return (
    <>
      <style>{LIST_SLIDEOVER_STYLES}</style>
      <div
        className="pw-list-slideover-overlay"
        onClick={localTransitions.requestClose}
        role="presentation"
      />
      <div
        className="pw-list-slideover"
        role="dialog"
        aria-modal="true"
        aria-label={`Details for ${currentList.name}`}
      >
        <button
          className="pw-list-slideover-close"
          onClick={localTransitions.requestClose}
          disabled={localTransitions.blocked}
          aria-label="Close"
          type="button"
        >
          ×
        </button>

        <header className="pw-list-slideover-header">
          <div className="pw-list-slideover-title-row">
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--pw-fg-subtle)",
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                }}
              >
                Audience list
              </div>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  color: "var(--pw-fg)",
                  marginTop: 4,
                  wordBreak: "break-word",
                }}
              >
                {currentList.name}
              </div>
              {currentList.description ? (
                <div
                  className="muted"
                  style={{ fontSize: 12, marginTop: 4, lineHeight: 1.5 }}
                >
                  {currentList.description}
                </div>
              ) : null}
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  marginTop: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <span
                  className={`badge ${isPublic ? "accent" : ""}`}
                  title={
                    isPublic
                      ? "Public in the audience service. Publish a Form to distribute a real hosted signup URL."
                      : "Private — only callable from server-side code or API."
                  }
                >
                  {isPublic ? "Public" : "Private"}
                </span>
                <span
                  className={`badge ${isDouble ? "success" : ""}`}
                  title={
                    isDouble
                      ? "Double opt-in: subscribers must click a confirmation email."
                      : "Single opt-in: subscribers added immediately on signup."
                  }
                >
                  {isDouble ? "Double opt-in" : "Single opt-in"}
                </span>
                <span className="muted tabular" style={{ fontSize: 11 }}>
                  {subscriberCount.toLocaleString()} subscriber
                  {subscriberCount === 1 ? "" : "s"}
                </span>
                <span
                  className="muted"
                  style={{ fontSize: 10 }}
                  title={`Created ${fmtDate(currentList.created_at)} · Updated ${fmtDate(currentList.updated_at)}`}
                >
                  {currentList.updated_at
                    ? `Updated ${fmtDate(currentList.updated_at)}`
                    : `Created ${fmtDate(currentList.created_at)}`}
                </span>
              </div>
            </div>
            {canMutate ? (
              <div className="pw-list-slideover-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={localTransitions.requestEdit}
                  disabled={localTransitions.blocked}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={localTransitions.requestDelete}
                  disabled={localTransitions.blocked}
                  style={{ color: "var(--pw-danger)" }}
                >
                  Delete
                </button>
              </div>
            ) : null}
          </div>

          <div
            ref={tabs.listRef}
            className="pw-list-slideover-tabbar"
            {...tabs.listProps}
            aria-label={`${currentList.name} list sections`}
          >
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                {...tabs.getTabProps(tab.id)}
                className={`pw-list-slideover-tab ${
                  activeTab === tab.id ? "is-active" : ""
                }`}
                disabled={localTransitions.blocked && activeTab !== tab.id}
              >
                <span>{tab.label}</span>
                {tabCounts[tab.id] ? (
                  <span className="pw-list-slideover-tab-count">
                    {tabCounts[tab.id]}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </header>

        {TABS.filter((tab) => tab.id !== activeTab).map((tab) => (
          <section key={tab.id} {...tabs.getPanelProps(tab.id)} />
        ))}
        <main
          {...tabs.getPanelProps(activeTab)}
          className="pw-list-slideover-body"
        >
          <ListTabBody
            activeTab={activeTab}
            list={currentList}
            health={health}
            onMembersTotalChange={setMembersTotal}
            onListUpdated={setCurrentList}
            onSettingsDraftStateChange={localTransitions.setSettingsState}
          />
        </main>
      </div>
      <ConfirmModal
        open={localTransitions.confirmOpen}
        title="Discard list settings changes?"
        description="The unsaved name, visibility, opt-in, tag, or description changes will be lost."
        confirmLabel="Discard changes"
        danger
        onConfirm={localTransitions.discardAndContinue}
        onClose={localTransitions.cancelDiscard}
      />
    </>
  );
}
