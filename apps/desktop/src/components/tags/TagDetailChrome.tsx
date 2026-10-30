import type { ReactElement } from "react";

import type { Tag } from "../../lib/api-client";
import { fmtDate } from "../../lib/format-date";
import { TAG_DELETE_UNAVAILABLE_REASON } from "../../pages/tags/tagPageModel";
import { PendingSyncStatus } from "../PendingSyncStatus";
import { tagColorPresentation } from "./tagColorPresentation";

export function TagDetailHeader({
  tag,
  count,
  titleId,
  descriptionId,
}: {
  tag: Tag;
  count: number | null;
  titleId: string;
  descriptionId: string;
}): ReactElement {
  const color = tagColorPresentation(tag.color);
  return (
    <header className="tag-detail-header">
      <div className="tag-detail-title-row">
        <span
          className="tag-swatch"
          style={{ background: color.background }}
          aria-hidden="true"
        />
        <h2 id={titleId} className="page-title">
          {tag.name}
        </h2>
        {color.legacy ? (
          <span
            className="tags-row-badge tags-row-badge-legacy"
            title={`Stored colour ${JSON.stringify(tag.color)} is unsupported and shown as neutral slate.`}
          >
            Legacy colour
          </span>
        ) : null}
      </div>
      <p id={descriptionId} className="muted">
        Created {fmtDate(tag.created_at)} ·{" "}
        {count === null
          ? "membership unverified"
          : `${count.toLocaleString()} subscriber${count === 1 ? "" : "s"}`}
      </p>
      <PendingSyncStatus
        path={`/api/v1/tags/${encodeURIComponent(tag.id)}`}
        compact
      />
    </header>
  );
}

export function TagDetailDangerZone(): ReactElement {
  return (
    <div className="tag-detail-danger-zone">
      <button
        type="button"
        className="btn btn-danger pw-discoverable-unavailable"
        aria-disabled="true"
        aria-describedby="tag-detail-delete-unavailable"
        onClick={(event) => event.preventDefault()}
      >
        Delete tag
      </button>
      <p id="tag-detail-delete-unavailable" className="field-help">
        {TAG_DELETE_UNAVAILABLE_REASON}
      </p>
    </div>
  );
}
