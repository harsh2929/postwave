/** Search and discoverable public-archive sharing controls. */

import type { ReactElement } from "react";

export function ArchiveShareControls({
  query,
  indexBase,
  publicIndexUrl,
  rssUrl,
  sitemapUrl,
  onQueryChange,
  onCopy,
  onOpen,
}: {
  query: string;
  indexBase: string | null;
  publicIndexUrl: string;
  rssUrl: string;
  sitemapUrl: string;
  onQueryChange: (value: string) => void;
  onCopy: (value: string, confirmation: string) => void;
  onOpen: (value: string) => void;
}): ReactElement {
  const unavailableClass = indexBase ? "" : " pw-discoverable-unavailable";
  const availability = {
    "aria-disabled": indexBase ? undefined : ("true" as const),
    "aria-describedby": "archive-public-url-availability",
  };
  const copy = (value: string, message: string): void => {
    if (indexBase) onCopy(value, message);
  };
  return (
    <>
      <div
        id="archive-public-url-availability"
        className="pw-action-status"
        role="status"
      >
        {indexBase ? (
          <>
            Public archive: <code>{indexBase}</code>. Copy controls expose the
            index, RSS feed, and sitemap URLs.
          </>
        ) : (
          "Set an archive slug in Settings before opening or copying public archive URLs."
        )}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <input
          id="archive-search"
          name="archive_search"
          className="input"
          aria-label="Search archive issues"
          style={{ width: 280 }}
          placeholder="Search by title or slug…"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <span className="spacer" />
        <button
          type="button"
          className={`btn btn-sm${unavailableClass}`}
          {...availability}
          onClick={() => copy(publicIndexUrl, "Public archive URL copied")}
        >
          Copy public URL
        </button>
        <button
          type="button"
          className={`btn btn-sm${unavailableClass}`}
          {...availability}
          onClick={() => copy(rssUrl, "RSS feed URL copied")}
        >
          Copy RSS
        </button>
        <button
          type="button"
          className={`btn btn-sm${unavailableClass}`}
          {...availability}
          onClick={() => copy(sitemapUrl, "Sitemap URL copied")}
        >
          Copy sitemap
        </button>
        <button
          type="button"
          className={`btn btn-sm${unavailableClass}`}
          {...availability}
          onClick={() => {
            if (indexBase) onOpen(indexBase);
          }}
        >
          Open public archive
        </button>
      </div>
    </>
  );
}
