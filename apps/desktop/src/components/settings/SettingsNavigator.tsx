import {
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

import {
  navigateDesktopRoute,
  type SettingsAnchor,
  useDesktopRoute,
} from "../../lib/desktop-router";
import {
  DEFAULT_SETTINGS_ANCHOR,
  searchSettings,
  SETTINGS_CATEGORIES,
  settingsCategoryLabel,
  settingsItemForAnchor,
  settingsItemsForCategory,
  type SettingsCategoryId,
  type SettingsInformationItem,
} from "../../lib/settings-information-architecture";
import { revealSettingsAnchor } from "../../lib/settings-anchor-focus";

interface SettingsNavigationIndexProps {
  activeAnchor: SettingsAnchor;
  onNavigate: (anchor: SettingsAnchor) => void;
}

export function SettingsNavigator(): ReactElement {
  const route = useDesktopRoute();
  const activeAnchor =
    route.section === "settings" && route.settingsAnchor
      ? route.settingsAnchor
      : DEFAULT_SETTINGS_ANCHOR;
  return (
    <SettingsNavigationIndex
      activeAnchor={activeAnchor}
      onNavigate={(anchor) => {
        if (anchor === activeAnchor && revealSettingsAnchor(anchor) !== null) {
          return;
        }
        navigateDesktopRoute({ section: "settings", settingsAnchor: anchor });
      }}
    />
  );
}

export function SettingsNavigationIndex({
  activeAnchor,
  onNavigate,
}: SettingsNavigationIndexProps): ReactElement {
  const activeItem = settingsItemForAnchor(activeAnchor);
  const [query, setQuery] = useState("");
  const [browseCategory, setBrowseCategory] = useState<SettingsCategoryId>(
    activeItem.category,
  );
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchId = useId();
  const resultsId = useId();
  const normalizedQuery = query.trim();
  const results = useMemo(() => searchSettings(query), [query]);
  const browseItems = settingsItemsForCategory(browseCategory);

  useEffect(() => {
    setBrowseCategory(activeItem.category);
    setQuery("");
    setHighlightedIndex(0);
  }, [activeAnchor, activeItem.category]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  useEffect(() => {
    const highlighted = results[highlightedIndex];
    if (!normalizedQuery || !highlighted) return;
    document
      .getElementById(`${resultsId}-${highlighted.anchor}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, normalizedQuery, results, resultsId]);

  const choose = (item: SettingsInformationItem): void => {
    setQuery("");
    setBrowseCategory(item.category);
    onNavigate(item.anchor);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    if (!normalizedQuery) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((current) => (current + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex(
        (current) => (current - 1 + results.length) % results.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected = results[highlightedIndex] ?? results[0];
      if (selected) choose(selected);
    }
  };

  return (
    <section className="settings-index" aria-labelledby={`${searchId}-title`}>
      <div className="settings-index-heading">
        <div>
          <h2 id={`${searchId}-title`}>Find a setting</h2>
          <nav aria-label="Current settings location">
            <ol className="settings-index-breadcrumbs">
              <li>Settings</li>
              <li>{settingsCategoryLabel(activeItem.category)}</li>
              <li aria-current="page">{activeItem.label}</li>
            </ol>
          </nav>
        </div>
        <label className="settings-index-search" htmlFor={searchId}>
          <span className="visually-hidden">Search settings</span>
          <span aria-hidden="true" className="settings-index-search-icon">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="6.5" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </span>
          <input
            id={searchId}
            type="search"
            value={query}
            maxLength={128}
            placeholder="Search settings"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={Boolean(normalizedQuery)}
            aria-controls={normalizedQuery ? resultsId : undefined}
            aria-activedescendant={
              normalizedQuery && results[highlightedIndex]
                ? `${resultsId}-${results[highlightedIndex].anchor}`
                : undefined
            }
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <kbd aria-hidden="true">↑↓</kbd>
        </label>
      </div>

      {normalizedQuery ? (
        <div className="settings-index-results-wrap">
          <div className="visually-hidden" role="status" aria-live="polite">
            {results.length === 0
              ? "No settings found"
              : `Showing ${results.length} matching setting${results.length === 1 ? "" : "s"}`}
          </div>
          {results.length > 0 ? (
            <ul
              className="settings-index-results"
              id={resultsId}
              role="listbox"
              aria-label="Settings search results"
            >
              {results.map((item, index) => (
                <li key={item.anchor} role="presentation">
                  <button
                    type="button"
                    id={`${resultsId}-${item.anchor}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === highlightedIndex}
                    className={
                      index === highlightedIndex ? "is-highlighted" : ""
                    }
                    onPointerMove={() => setHighlightedIndex(index)}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => choose(item)}
                  >
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.summary}</small>
                    </span>
                    <span className="settings-index-result-category">
                      {settingsCategoryLabel(item.category)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <ul
                className="settings-index-results"
                id={resultsId}
                role="listbox"
                aria-label="Settings search results"
              />
              <div className="settings-index-empty">
                <strong>No settings found</strong>
                <span>
                  Try a feature, task, or synonym such as “2FA” or “DNS”.
                </span>
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          <div
            className="settings-index-categories"
            aria-label="Settings categories"
          >
            {SETTINGS_CATEGORIES.map((category) => (
              <button
                type="button"
                key={category.id}
                aria-pressed={browseCategory === category.id}
                onClick={() => setBrowseCategory(category.id)}
              >
                {category.label}
              </button>
            ))}
          </div>
          <ul
            className="settings-index-browse"
            aria-label={`${settingsCategoryLabel(browseCategory)} settings`}
          >
            {browseItems.map((item) => (
              <li key={item.anchor}>
                <button
                  type="button"
                  className={item.anchor === activeAnchor ? "is-active" : ""}
                  aria-current={
                    item.anchor === activeAnchor ? "location" : undefined
                  }
                  onClick={() => choose(item)}
                >
                  <span>{item.label}</span>
                  <small>{item.summary}</small>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
