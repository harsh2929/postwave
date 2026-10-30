import { type ReactElement, useEffect, useState } from "react";

import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import { useDesktopRouteTab } from "../../lib/desktop-router";
import { SubscribersBrowseSection } from "./SubscribersBrowseSection";
import { SubscribersPageOverlays } from "./SubscribersPageOverlays";
import {
  SubscribersGovernancePanels,
  SubscribersInsightsPanels,
  SubscribersPageHeader,
  SubscribersRulesPanels,
} from "./SubscribersTopPanels";
import { SubscribersSegmentsPanels } from "./SubscribersSegmentsPanels";
import type { SubscribersPageController } from "./useSubscribersPageController";

import "../../styles-subscribers.css";
import "../../styles/subscribers-pii.css";

type SubscribersWorkspaceTab =
  | "directory"
  | "insights"
  | "segments"
  | "governance"
  | "rules";

const SUBSCRIBERS_WORKSPACE_TABS = [
  { value: "directory" },
  { value: "insights" },
  { value: "segments" },
  { value: "governance" },
  { value: "rules" },
] as const;

const SUBSCRIBERS_WORKSPACE_TAB_VALUES: readonly SubscribersWorkspaceTab[] =
  SUBSCRIBERS_WORKSPACE_TABS.map(({ value }) => value);

const TAB_COPY: Record<
  SubscribersWorkspaceTab,
  { label: string; eyebrow: string; title: string; description: string }
> = {
  directory: {
    label: "Directory",
    eyebrow: "Operate",
    title: "Subscriber directory",
    description:
      "Search, verify, and act on one explicit server-backed view. Selection stays scoped to the visible page.",
  },
  insights: {
    label: "Insights",
    eyebrow: "Understand",
    title: "Audience signals",
    description:
      "Read growth, lifecycle, and engagement evidence with its calculation scope kept visible.",
  },
  segments: {
    label: "Segments",
    eyebrow: "Target",
    title: "Reusable audiences",
    description:
      "Review saved definitions, reopen an exact view, or compile a new segment before it reaches a campaign.",
  },
  governance: {
    label: "Governance",
    eyebrow: "Protect",
    title: "Data governance",
    description:
      "Review sensitive-data findings and retention policy without mixing destructive controls into daily browsing.",
  },
  rules: {
    label: "Rules & fields",
    eyebrow: "Configure",
    title: "Fields and audience rules",
    description:
      "Manage schema and scoring contracts that shape imports, personalization, and downstream automation.",
  },
};

export function SubscribersPagePresentation({
  controller,
}: {
  controller: SubscribersPageController;
}): ReactElement {
  const [tab, setTab] = useDesktopRouteTab<SubscribersWorkspaceTab>(
    "subscribers",
    SUBSCRIBERS_WORKSPACE_TAB_VALUES,
    "directory",
  );
  const [visited, setVisited] = useState<
    Record<SubscribersWorkspaceTab, boolean>
  >(() => ({
    directory: tab === "directory",
    insights: tab === "insights",
    segments: tab === "segments",
    governance: tab === "governance",
    rules: tab === "rules",
  }));
  const tabs = useTabsInteraction({
    activation: "manual",
    value: tab,
    items: SUBSCRIBERS_WORKSPACE_TABS,
    onChange: setTab,
  });

  useEffect(() => {
    setVisited((current) =>
      current[tab] ? current : { ...current, [tab]: true },
    );
  }, [tab]);

  return (
    <>
      <SubscribersPageHeader controller={controller} />
      <nav
        className="subscribers-workspace-nav"
        aria-label="Subscriber workspaces"
      >
        <div className="subscribers-workspace-tabs-scroll">
          <div
            ref={tabs.listRef}
            className="lib-segmented subscribers-workspace-tabs"
            {...tabs.listProps}
            aria-label="Subscriber workspaces"
          >
            {SUBSCRIBERS_WORKSPACE_TABS.map(({ value }) => (
              <button
                key={value}
                type="button"
                {...tabs.getTabProps(value)}
                className={tab === value ? "is-active" : undefined}
              >
                {TAB_COPY[value].label}
                {value === "segments" &&
                controller.saved.savedSegments.length > 0 ? (
                  <span className="subscribers-tab-count" aria-hidden="true">
                    {controller.saved.savedSegments.length}
                  </span>
                ) : null}
                {value === "segments" &&
                controller.saved.savedSegments.length > 0 ? (
                  <span className="visually-hidden">
                    {controller.saved.savedSegments.length} saved
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {SUBSCRIBERS_WORKSPACE_TABS.map(({ value }) => {
        const copy = TAB_COPY[value];
        return (
          <section key={value} {...tabs.getPanelProps(value)}>
            {visited[value] ? (
              <>
                <div className="subscribers-workspace-intro">
                  <div>
                    <span>{copy.eyebrow}</span>
                    <h2>{copy.title}</h2>
                  </div>
                  <p>{copy.description}</p>
                </div>
                <SubscribersWorkspacePanel
                  tab={value}
                  controller={controller}
                  onOpenDirectory={() => setTab("directory")}
                />
              </>
            ) : null}
          </section>
        );
      })}

      <SubscribersPageOverlays controller={controller} />
    </>
  );
}

function SubscribersWorkspacePanel({
  tab,
  controller,
  onOpenDirectory,
}: {
  tab: SubscribersWorkspaceTab;
  controller: SubscribersPageController;
  onOpenDirectory: () => void;
}): ReactElement {
  switch (tab) {
    case "directory":
      return <SubscribersBrowseSection controller={controller} />;
    case "insights":
      return <SubscribersInsightsPanels controller={controller} />;
    case "segments":
      return (
        <SubscribersSegmentsPanels
          controller={controller}
          onOpenDirectory={onOpenDirectory}
        />
      );
    case "governance":
      return <SubscribersGovernancePanels controller={controller} />;
    case "rules":
      return <SubscribersRulesPanels controller={controller} />;
  }
}
