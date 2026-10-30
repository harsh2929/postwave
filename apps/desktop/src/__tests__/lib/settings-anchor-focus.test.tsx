// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  revealSettingsAnchor,
  resolveSettingsAnchorElements,
  useSettingsAnchorFocus,
} from "../../lib/settings-anchor-focus";
import { SETTINGS_INFORMATION_ARCHITECTURE } from "../../lib/settings-information-architecture";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const scrollIntoView = vi.fn();

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  scrollIntoView.mockReset();
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
    scrollIntoView,
  );
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Settings anchor focus", () => {
  it("assigns the canonical anchor and separates section scroll from heading focus", () => {
    const content = document.createElement("main");
    content.innerHTML = `
      <section class="settings-section">
        <div class="settings-section-head">
          <h2 class="settings-section-title">API keys</h2>
        </div>
      </section>`;
    const result = resolveSettingsAnchorElements(content, "api-keys");
    expect(result?.scrollOwner.id).toBe("settings-api-keys");
    expect(result?.scrollOwner.dataset.settingsAnchor).toBe("api-keys");
    expect(result?.focusOwner.tagName).toBe("H2");
  });

  it("focuses a real heading inside an explicitly named compatibility anchor", () => {
    const content = document.createElement("main");
    content.innerHTML = `
      <section class="settings-section" data-settings-anchor="outbound-webhooks">
        <div class="settings-section-head">
          <h2 class="settings-section-title">Webhook administration</h2>
        </div>
      </section>`;
    const result = resolveSettingsAnchorElements(content, "outbound-webhooks");
    expect(result?.scrollOwner.dataset.settingsAnchor).toBe(
      "outbound-webhooks",
    );
    expect(result?.focusOwner.textContent).toBe("Webhook administration");
  });

  it("resolves every typed destination to a real, canonically named heading", () => {
    const content = document.createElement("main");
    for (const item of SETTINGS_INFORMATION_ARCHITECTURE) {
      const section = document.createElement("section");
      section.className = "settings-section";
      const heading = document.createElement("h2");
      heading.className = "settings-section-title";
      heading.textContent = item.label;
      section.appendChild(heading);
      content.appendChild(section);
    }
    for (const item of SETTINGS_INFORMATION_ARCHITECTURE) {
      const result = resolveSettingsAnchorElements(content, item.anchor);
      expect(result?.focusOwner.tagName).toBe("H2");
      expect(result?.focusOwner.textContent).toBe(item.label);
    }
  });

  it("waits for a delayed section, then scrolls and focuses exactly once", async () => {
    const view = render(<Harness show={false} />);
    view.rerender(<Harness show />);
    await act(async () => Promise.resolve());

    const heading = document.querySelector<HTMLElement>(
      ".settings-section-title",
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(heading?.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(heading);
  });

  it("re-reveals an already active anchor without requiring a route revision", () => {
    document.body.innerHTML = `
      <main id="main-content">
        <section class="settings-section">
          <h2 class="settings-section-title">API keys</h2>
        </section>
      </main>`;
    const frame = revealSettingsAnchor("api-keys");
    const heading = document.querySelector<HTMLElement>(
      ".settings-section-title",
    );
    expect(frame).toBe(1);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(heading);
  });
});

function Harness({ show }: { show: boolean }): ReactElement {
  useSettingsAnchorFocus({
    section: "settings",
    settingsAnchor: "data-retention",
  });
  return (
    <main id="main-content">
      {show ? (
        <section className="settings-section">
          <h2 className="settings-section-title">Data retention</h2>
        </section>
      ) : null}
    </main>
  );
}

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return { rerender: (next) => act(() => root?.render(next)) };
}
