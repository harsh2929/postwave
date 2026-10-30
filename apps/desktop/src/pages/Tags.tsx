/** Tenant-scoped tag catalogue page. */

import type { ReactElement } from "react";

import "../styles-tags.css";
import "../styles-action-availability.css";

import { TagsPageView } from "./tags/TagsPageView";
import { useTagsPageController } from "./tags/useTagsPageController";

export function Tags(): ReactElement {
  const controller = useTagsPageController();
  return <TagsPageView controller={controller} />;
}
