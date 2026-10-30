export type DesktopDragTaskKind =
  | "file-import"
  | "insert"
  | "reorder"
  | "reschedule";

export interface DesktopDragAlternativeContract {
  id: string;
  kind: DesktopDragTaskKind;
  owners: readonly string[];
  /** Non-drag UI may live in a parent rather than the event owner. */
  evidenceOwners?: readonly string[];
  pointerAction: string;
  nonDragAction: string;
  /** Source tokens pinned by the contract test in the same owner set. */
  evidenceTokens: readonly string[];
}

/**
 * Complete production inventory of app-owned HTML drag interactions.
 *
 * Drag may accelerate a task but can never be its only completion path. The
 * source contract discovers every onDragStart/onDragEnter/onDrop owner and
 * fails when a new file is not assigned here.
 */
export const DESKTOP_DRAG_ALTERNATIVES = [
  {
    id: "asset-library-file-import",
    kind: "file-import",
    owners: ["components/library/LibraryDropZone.tsx"],
    evidenceOwners: [
      "pages/Assets.tsx",
      "components/library/LibraryToolbar.tsx",
    ],
    pointerAction:
      "Drop one or more image files anywhere on the asset library.",
    nonDragAction:
      "Use the Upload action and native picker with the same validation policy.",
    evidenceTokens: [
      "pickImportFiles",
      "onUploadButtonClick",
      "if (canUpload) onUpload();",
    ],
  },
  {
    id: "collection-file-import",
    kind: "file-import",
    owners: ["components/Collections.tsx"],
    pointerAction: "Drop a CSV or JSON file into the collection importer.",
    nonDragAction: "Open the native picker and choose the same validated file.",
    evidenceTokens: ["pickImportFiles", "COLLECTION_IMPORT_POLICY"],
  },
  {
    id: "migration-file-import",
    kind: "file-import",
    owners: ["components/migration/MigrationFileFieldInput.tsx"],
    pointerAction: "Drop a migration CSV into the wizard.",
    nonDragAction: "Use the labelled Choose control and native file picker.",
    evidenceTokens: ["pickImportFiles", "Choose ${label}"],
  },
  {
    id: "analytics-kpi-reorder",
    kind: "reorder",
    owners: ["components/analytics/KpiConfigMenu.tsx"],
    pointerAction: "Drag KPI configuration rows into a new order.",
    nonDragAction: "Use the named Move up and Move down buttons.",
    evidenceTokens: ["moveByOffset", "Move ${KPI_LABELS[entry.key]} up"],
  },
  {
    id: "campaign-calendar-reschedule",
    kind: "reschedule",
    owners: ["components/campaigns/CampaignCalendar.tsx"],
    pointerAction: "Drag a scheduled campaign to another calendar day.",
    nonDragAction:
      "Open Reschedule, enter a date, and submit the labelled form.",
    evidenceTokens: ["Reschedule ${label}", 'type="date"', "submitReschedule"],
  },
  {
    id: "dashboard-metric-reorder",
    kind: "reorder",
    owners: [
      "components/dashboard/DashboardStatGrid.tsx",
      "components/dashboard/StatCard.tsx",
    ],
    pointerAction: "Drag dashboard metric cards into a new order.",
    nonDragAction:
      "Use named Move earlier and Move later controls with position feedback.",
    evidenceTokens: ["moveCard", "Move ${label} earlier", "aria-posinset"],
  },
  {
    id: "saved-segment-reorder",
    kind: "reorder",
    owners: ["components/segments/SavedSegmentsManagerView.tsx"],
    pointerAction: "Drag pinned saved segments into a new order.",
    nonDragAction: "Use the named Move up and Move down buttons.",
    evidenceTokens: ["movePinned", 'Move ${segment.name || "segment"} up'],
  },
  {
    id: "sequence-step-canvas",
    kind: "reorder",
    owners: [
      "components/sequence/StepCanvas.tsx",
      "components/sequence/StepConnector.tsx",
      "components/sequence/StepNode.tsx",
      "components/sequence/StepPalette.tsx",
    ],
    pointerAction: "Drag palette, trunk, or branch steps to insert or reorder.",
    nonDragAction:
      "Use palette Add buttons plus Move earlier/later controls for trunk and branch steps.",
    evidenceTokens: [
      "moveExistingStep",
      "moveBranchStep",
      "Add ${tile.label} step at the end",
      "onMoveEarlier",
    ],
  },
  {
    id: "inbound-route-reorder",
    kind: "reorder",
    owners: ["pages/inbound-routes/InboundRoutesTable.tsx"],
    evidenceOwners: ["pages/InboundRoutes.tsx"],
    pointerAction: "Drag inbound routes into priority order.",
    nonDragAction:
      "Use Move up/down for routes and for actions inside a route.",
    evidenceTokens: [
      "onMoveUp",
      "Move ${routeLabel} earlier",
      "Move action ${index + 1} earlier",
    ],
  },
] as const satisfies readonly DesktopDragAlternativeContract[];
