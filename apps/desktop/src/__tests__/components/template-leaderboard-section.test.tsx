// @vitest-environment happy-dom

import { act } from "react";
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

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  analyticsExtrasApi: {
    templateLeaderboard: mocks.load,
  },
}));

import { TemplateLeaderboardSection } from "../../components/templates/TemplateLeaderboardSection";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue({
    data: {
      items: [
        {
          template_id: "template-1",
          template_name: "Lifecycle welcome",
          campaigns_used: 12,
          sent: 24_000,
          opens: 12_240,
          clicks: 3_120,
          open_rate: 0.51,
          click_rate: 0.13,
        },
      ],
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<TemplateLeaderboardSection />));
}

function performanceButton(): HTMLButtonElement {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.includes("Performance"));
  if (!button) throw new Error("Missing Performance disclosure");
  return button;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TemplateLeaderboardSection", () => {
  it("loads lazily and exposes exact counts without hover-only titles", async () => {
    render();
    expect(mocks.load).not.toHaveBeenCalled();

    act(() => performanceButton().click());
    await flush();

    expect(mocks.load).toHaveBeenCalledWith({ days: 30 });
    expect(document.body.textContent).toContain("51.0%");
    expect(document.body.textContent).toContain("12,240 opens");
    expect(document.body.textContent).toContain("13.0%");
    expect(document.body.textContent).toContain("3,120 clicks");
    expect(document.querySelector('[title*="opens"]')).toBeNull();
    expect(document.querySelector('[title*="clicks"]')).toBeNull();
  });

  it("fails closed when a successful payload contains an impossible rate", async () => {
    mocks.load.mockResolvedValue({
      data: {
        items: [
          {
            template_id: "template-1",
            template_name: "Lifecycle welcome",
            campaigns_used: 1,
            sent: 10,
            opens: 9,
            clicks: 2,
            open_rate: 90,
            click_rate: 0.2,
          },
        ],
      },
    });
    render();

    act(() => performanceButton().click());
    await flush();

    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /invalid template-performance response/i,
    );
    expect(document.body.textContent).not.toContain("Lifecycle welcome");
  });
});
