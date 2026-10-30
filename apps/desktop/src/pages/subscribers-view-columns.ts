import type { ColumnDef } from "../components/subscribers/ColumnPicker";
import type { SubscribersViewPrefs } from "../lib/api-client";

export const SUBSCRIBER_COLUMN_CATALOG: readonly ColumnDef[] = [
  { key: "avatar", label: "Avatar", width: "32px" },
  { key: "email", label: "Email", width: "1.5fr", required: true },
  { key: "first_name", label: "First name", width: "120px" },
  { key: "last_name", label: "Last name", width: "120px" },
  { key: "full_name", label: "Full name", width: "160px" },
  { key: "display_name", label: "Display name", width: "140px" },
  { key: "status", label: "Status", width: "120px" },
  { key: "joined", label: "Joined", width: "110px" },
  { key: "engagement", label: "Engagement", width: "110px", numeric: true },
  { key: "rating", label: "Rating", width: "90px", numeric: true },
  { key: "churn_score", label: "Churn score", width: "100px", numeric: true },
  { key: "archived_at", label: "Archived", width: "120px" },
  { key: "tags", label: "Tags", width: "1fr" },
];

const DEFAULT_COLUMNS = [
  "avatar",
  "email",
  "status",
  "joined",
  "engagement",
  "tags",
];

const COLUMN_CATALOG_BY_KEY: Readonly<Record<string, ColumnDef>> =
  Object.fromEntries(
    SUBSCRIBER_COLUMN_CATALOG.map((column) => [column.key, column]),
  );

export function visibleSubscriberColumns(
  preferences: SubscribersViewPrefs,
): string[] {
  const requested =
    preferences.columns && preferences.columns.length > 0
      ? preferences.columns
      : DEFAULT_COLUMNS;
  const seen = new Set<string>();
  const visible = requested.filter((key) => {
    if (!Object.hasOwn(COLUMN_CATALOG_BY_KEY, key) || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  if (!visible.includes("email")) visible.unshift("email");
  return visible;
}

export function subscriberGridTemplate(visibleColumns: string[]): string {
  const columns = visibleColumns
    .map((key) => COLUMN_CATALOG_BY_KEY[key]?.width ?? "1fr")
    .join(" ");
  return `32px ${columns} 64px`;
}

export function subscriberColumnDefinition(key: string): ColumnDef | undefined {
  return Object.hasOwn(COLUMN_CATALOG_BY_KEY, key)
    ? COLUMN_CATALOG_BY_KEY[key]
    : undefined;
}
