// @vitest-environment happy-dom

import axe from "axe-core";
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

import { AuthShell } from "../../components/AuthShell";
import { AuthShowcase } from "../../components/AuthShowcase";
import {
  AUTH_SHOWCASE_INTERVAL_MS,
  type AuthShowcaseSlides,
} from "../../lib/auth-showcase";

const SLIDES = [
  {
    id: "campaigns",
    tone: "mint",
    icon: "campaigns",
    illustration: "/campaigns.webp",
    eyebrow: "Campaigns",
    headline: "Draft and send campaigns.",
    sub: "A campaign capability summary.",
    descriptor: "Broadcast workflow",
    capabilities: [
      { label: "Draft", detail: "Shape the message" },
      { label: "Test", detail: "Review the result" },
    ],
  },
  {
    id: "audience",
    tone: "blue",
    icon: "audience",
    illustration: "/audience.webp",
    eyebrow: "Audience",
    headline: "Build useful audiences.",
    sub: "An audience capability summary.",
    descriptor: "Audience toolkit",
    capabilities: [
      { label: "Import", detail: "Bring contacts in" },
      { label: "Segment", detail: "Build reusable groups" },
    ],
  },
  {
    id: "analytics",
    tone: "sand",
    icon: "analytics",
    illustration: "/analytics.webp",
    eyebrow: "Analytics",
    headline: "Inspect recorded results.",
    sub: "An analytics capability summary.",
    descriptor: "Recorded signals",
    capabilities: [
      { label: "Opens", detail: "Inspect recorded opens" },
      { label: "Clicks", detail: "Follow engagement" },
    ],
  },
] as const satisfies AuthShowcaseSlides;

const originalMatchMedia = Object.getOwnPropertyDescriptor(
  window,
  "matchMedia",
);
const originalVisibilityState = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let visibilityState: DocumentVisibilityState = "visible";
let reducedMotion = false;
let motionListeners = new Set<EventListener>();

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  visibilityState = "visible";
  reducedMotion = false;
  motionListeners = new Set<EventListener>();

  const mediaQueryList = {
    get matches() {
      return reducedMotion;
    },
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: (type: string, listener: EventListener) => {
      if (type === "change") motionListeners.add(listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      if (type === "change") motionListeners.delete(listener);
    },
    addListener: (listener: EventListener) => motionListeners.add(listener),
    removeListener: (listener: EventListener) =>
      motionListeners.delete(listener),
    dispatchEvent: (event: Event) => {
      for (const listener of [...motionListeners]) listener(event);
      return true;
    },
  } as unknown as MediaQueryList;

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => mediaQueryList),
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreProperty(window, "matchMedia", originalMatchMedia);
  restoreProperty(document, "visibilityState", originalVisibilityState);
});

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function unmount(): void {
  const mountedRoot = root;
  root = null;
  if (mountedRoot) act(() => mountedRoot.unmount());
}

function activeEyebrow(): string | null {
  return (
    document.querySelector(".auth-showcase-copy.is-active .auth-aside-eyebrow")
      ?.textContent ?? null
  );
}

function expectActive(label: string): void {
  expect(activeEyebrow()).toBe(label);
}

function dot(index: number, label: string): HTMLButtonElement {
  const found =
    document.querySelectorAll<HTMLButtonElement>(".auth-showcase-dot")[
      index - 1
    ];
  if (!found) throw new Error(`Missing slide dot: ${index}, ${label}`);
  return found;
}

function showcase(): HTMLElement {
  const found = document.querySelector<HTMLElement>(".auth-showcase");
  if (!found) throw new Error("Missing showcase");
  return found;
}

function advance(milliseconds: number): void {
  act(() => {
    vi.advanceTimersByTime(milliseconds);
  });
}

function click(target: HTMLElement): void {
  act(() => target.click());
}

function pointerClick(target: HTMLElement): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerType: "mouse",
      }),
    );
    target.focus();
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
    );
  });
}

function key(target: HTMLElement, value: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: value,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function setVisibility(next: DocumentVisibilityState): void {
  visibilityState = next;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function setWindowActive(active: boolean): void {
  act(() => {
    window.dispatchEvent(new Event(active ? "focus" : "blur"));
  });
}

function setReducedMotion(next: boolean): void {
  reducedMotion = next;
  act(() => {
    const event = new Event("change");
    for (const listener of [...motionListeners]) listener(event);
  });
}

describe("AuthShowcase", () => {
  it("rotates at exactly 10 seconds and wraps silently", () => {
    render(<AuthShowcase slides={SLIDES} />);
    expectActive("Campaigns");
    expect(showcase().classList.contains("is-rotating")).toBe(true);

    advance(AUTH_SHOWCASE_INTERVAL_MS - 1);
    expectActive("Campaigns");
    advance(1);
    expectActive("Audience");
    expect(showcase().dataset.direction).toBe("forward");
    expect(document.querySelector('[role="status"]')?.textContent).toBe("");

    advance(AUTH_SHOWCASE_INTERVAL_MS);
    expectActive("Analytics");
    advance(AUTH_SHOWCASE_INTERVAL_MS);
    expectActive("Campaigns");
    expect(dot(1, "Campaigns").getAttribute("aria-current")).toBe("true");
  });

  it("gives hover, document, and desktop-window pauses a fresh 10 seconds", () => {
    render(<AuthShowcase slides={SLIDES} />);
    const aside = document.querySelector<HTMLElement>(".auth-aside-showcase");
    if (!aside) throw new Error("Missing showcase aside");

    advance(4_000);
    act(() => {
      aside.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(showcase().classList.contains("is-paused")).toBe(true);
    advance(20_000);
    expectActive("Campaigns");
    act(() => {
      aside.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    advance(AUTH_SHOWCASE_INTERVAL_MS - 1);
    expectActive("Campaigns");
    advance(1);
    expectActive("Audience");

    advance(4_000);
    setVisibility("hidden");
    advance(20_000);
    expectActive("Audience");
    setVisibility("visible");
    advance(AUTH_SHOWCASE_INTERVAL_MS - 1);
    expectActive("Audience");
    advance(1);
    expectActive("Analytics");

    advance(4_000);
    setWindowActive(false);
    advance(20_000);
    expectActive("Analytics");
    setWindowActive(true);
    advance(AUTH_SHOWCASE_INTERVAL_MS - 1);
    expectActive("Analytics");
    advance(1);
    expectActive("Campaigns");
  });

  it("does not resume an overlapping transient pause until every cause clears", () => {
    render(<AuthShowcase slides={SLIDES} />);
    const aside = document.querySelector<HTMLElement>(".auth-aside-showcase");
    if (!aside) throw new Error("Missing showcase aside");

    act(() => {
      aside.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    setWindowActive(false);
    act(() => {
      aside.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    advance(AUTH_SHOWCASE_INTERVAL_MS * 2);
    expectActive("Campaigns");

    setWindowActive(true);
    advance(AUTH_SHOWCASE_INTERVAL_MS - 1);
    expectActive("Campaigns");
    advance(1);
    expectActive("Audience");
  });

  it("does not rotate when mounted into an already-unfocused window", () => {
    vi.spyOn(document, "hasFocus").mockReturnValueOnce(false);
    render(<AuthShowcase slides={SLIDES} />);

    advance(AUTH_SHOWCASE_INTERVAL_MS * 2);
    expectActive("Campaigns");

    setWindowActive(true);
    advance(AUTH_SHOWCASE_INTERVAL_MS - 1);
    expectActive("Campaigns");
    advance(1);
    expectActive("Audience");
  });

  it("stops durably on focus and resumes only after explicit activation and blur", () => {
    const outside = document.createElement("button");
    outside.type = "button";
    document.body.appendChild(outside);
    render(<AuthShowcase slides={SLIDES} />);

    const activeDot = dot(1, "Campaigns");
    advance(4_000);
    act(() => activeDot.focus());
    expect(showcase().dataset.autoplay).toBe("off");
    expect(activeDot.getAttribute("aria-label")).toBe(
      "Resume automatic rotation. Campaigns, slide 1 of 3.",
    );
    expect(document.activeElement).toBe(activeDot);
    advance(AUTH_SHOWCASE_INTERVAL_MS * 2);
    expectActive("Campaigns");

    act(() => outside.focus());
    advance(AUTH_SHOWCASE_INTERVAL_MS * 2);
    expectActive("Campaigns");

    act(() => activeDot.focus());
    click(activeDot);
    expect(showcase().dataset.autoplay).toBe("on");
    expect(showcase().classList.contains("is-paused")).toBe(true);
    expect(activeDot.getAttribute("aria-label")).toBe(
      "Pause automatic rotation. Campaigns, slide 1 of 3.",
    );
    advance(AUTH_SHOWCASE_INTERVAL_MS * 2);
    expectActive("Campaigns");

    act(() => outside.focus());
    advance(AUTH_SHOWCASE_INTERVAL_MS - 1);
    expectActive("Campaigns");
    advance(1);
    expectActive("Audience");
  });

  it("uses the pre-focus autoplay state for real pointer activation", () => {
    render(<AuthShowcase slides={SLIDES} />);
    const activeDot = dot(1, "Campaigns");

    pointerClick(activeDot);
    expectActive("Campaigns");
    expect(showcase().dataset.autoplay).toBe("off");
    expect(activeDot.getAttribute("aria-label")).toBe(
      "Resume automatic rotation. Campaigns, slide 1 of 3.",
    );
    advance(AUTH_SHOWCASE_INTERVAL_MS * 2);
    expectActive("Campaigns");
  });

  it("renders only the compact slide-dot navigator as carousel controls", () => {
    render(<AuthShowcase slides={SLIDES} />);
    const buttons = [...showcase().querySelectorAll("button")];
    expect(
      showcase().querySelector(".auth-showcase-pagination"),
    ).not.toBeNull();
    expect(buttons).toHaveLength(SLIDES.length);
    expect(
      buttons.map((control) => control.getAttribute("aria-label")),
    ).toEqual([
      "Pause automatic rotation. Campaigns, slide 1 of 3.",
      "Show Audience, slide 2 of 3, and pause automatic rotation.",
      "Show Analytics, slide 3 of 3, and pause automatic rotation.",
    ]);
    expect(showcase().querySelector(".auth-showcase-actions")).toBeNull();
    expect(showcase().querySelector(".auth-showcase-dock-count")).toBeNull();
    expect(showcase().querySelector(".auth-showcase-control")).toBeNull();
    expect(showcase().querySelector("[data-action-label]")).toBeNull();
    expect(buttons.filter((control) => control.tabIndex === 0)).toHaveLength(1);
    expect(
      buttons.filter((control) => control.hasAttribute("aria-current")),
    ).toHaveLength(1);
    expect(
      buttons.every((control) => !control.hasAttribute("aria-pressed")),
    ).toBe(true);
    expect(
      document.querySelector("#auth-showcase-navigation-help")?.textContent,
    ).toContain("pauses or resumes automatic rotation");
    expect(
      showcase().style.getPropertyValue("--auth-showcase-cycle-duration"),
    ).toBe(`${AUTH_SHOWCASE_INTERVAL_MS}ms`);
  });

  it("pauses after dot navigation and supports roving Arrow, Home, and End keys", () => {
    render(<AuthShowcase slides={SLIDES} />);

    click(dot(3, "Analytics"));
    expectActive("Analytics");
    expect(showcase().dataset.direction).toBe("forward");
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Analytics, slide 3 of 3. Automatic rotation paused.",
    );
    advance(AUTH_SHOWCASE_INTERVAL_MS * 2);
    expectActive("Analytics");

    click(dot(1, "Campaigns"));
    expectActive("Campaigns");
    expect(showcase().dataset.direction).toBe("backward");
    click(dot(2, "Audience"));
    expectActive("Audience");
    expect(dot(2, "Audience").getAttribute("aria-current")).toBe("true");

    expect(key(dot(2, "Audience"), "ArrowRight").defaultPrevented).toBe(true);
    expectActive("Analytics");
    expect(document.activeElement).toBe(dot(3, "Analytics"));

    key(dot(3, "Analytics"), "ArrowRight");
    expectActive("Campaigns");
    expect(document.activeElement).toBe(dot(1, "Campaigns"));

    key(dot(1, "Campaigns"), "End");
    expectActive("Analytics");
    key(dot(3, "Analytics"), "Home");
    expectActive("Campaigns");
    key(dot(1, "Campaigns"), "ArrowLeft");
    expectActive("Analytics");
    expect(showcase().dataset.direction).toBe("backward");
  });

  it("presents each active story as a uniquely named heading and capability list", () => {
    render(<AuthShowcase slides={SLIDES} />);

    const activeStory = document.querySelector<HTMLElement>(
      ".auth-showcase-copy.is-active",
    );
    expect(activeStory?.getAttribute("aria-roledescription")).toBe("slide");
    expect(activeStory?.getAttribute("aria-label")).toBe("Campaigns, 1 of 3");
    expect(activeStory?.querySelector("h2")?.textContent).toBe(
      "Draft and send campaigns.",
    );
    expect(
      activeStory?.querySelector(
        'ul[aria-label="Broadcast workflow capabilities"]',
      ),
    ).not.toBeNull();
    expect(activeStory?.textContent).toContain("Shape the message");
    expect(
      document.querySelectorAll('.auth-showcase-copy[aria-hidden="true"]'),
    ).toHaveLength(2);
    expect(
      activeStory
        ?.querySelector(".auth-showcase-copy-glow")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(dot(1, "Campaigns").getAttribute("aria-controls")).toBe(
      "auth-showcase-slide-campaigns",
    );
  });

  it("does not autoplay for initial reduced motion but keeps manual dots", () => {
    reducedMotion = true;
    render(<AuthShowcase slides={SLIDES} />);

    expectActive("Campaigns");
    expect(showcase().dataset.autoplay).toBe("off");
    expect(dot(1, "Campaigns").getAttribute("aria-label")).toBe(
      "Campaigns, current slide 1 of 3. Automatic rotation is disabled by reduced motion.",
    );
    click(dot(1, "Campaigns"));
    expect(showcase().dataset.autoplay).toBe("off");
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Automatic rotation remains off because reduced motion is enabled.",
    );
    advance(AUTH_SHOWCASE_INTERVAL_MS * 2);
    expectActive("Campaigns");

    click(dot(2, "Audience"));
    expectActive("Audience");
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Audience, slide 2 of 3. Automatic rotation remains off because reduced motion is enabled.",
    );
    expect(dot(2, "Audience").getAttribute("aria-label")).toBe(
      "Audience, current slide 2 of 3. Automatic rotation is disabled by reduced motion.",
    );
    advance(AUTH_SHOWCASE_INTERVAL_MS * 2);
    expectActive("Audience");
  });

  it("stops when reduced motion is enabled live and never restarts implicitly", () => {
    render(<AuthShowcase slides={SLIDES} />);
    advance(4_000);
    setReducedMotion(true);
    advance(AUTH_SHOWCASE_INTERVAL_MS * 2);
    expectActive("Campaigns");
    expect(showcase().dataset.autoplay).toBe("off");

    setReducedMotion(false);
    advance(AUTH_SHOWCASE_INTERVAL_MS * 2);
    expectActive("Campaigns");

    click(dot(2, "Audience"));
    expectActive("Audience");
  });

  it("clamps the active scene if a caller replaces the slide collection", () => {
    render(<AuthShowcase slides={SLIDES} />);
    click(dot(3, "Analytics"));
    expectActive("Analytics");

    const oneSlide = [SLIDES[0]] as unknown as AuthShowcaseSlides;
    act(() => root?.render(<AuthShowcase slides={oneSlide} />));
    expectActive("Campaigns");
    expect(
      document.querySelectorAll(".auth-showcase-copy.is-active"),
    ).toHaveLength(1);
  });

  it("does not advertise or enable automatic rotation for one slide", () => {
    const oneSlide = [SLIDES[0]] as unknown as AuthShowcaseSlides;
    render(<AuthShowcase slides={oneSlide} />);

    const currentDot = dot(1, "Campaigns");
    expect(showcase().dataset.autoplay).toBe("off");
    expect(showcase().classList.contains("is-paused")).toBe(true);
    expect(currentDot.getAttribute("aria-label")).toBe(
      "Campaigns, only slide. Automatic rotation is unavailable because there is only one slide.",
    );
    expect(
      document.querySelector("#auth-showcase-navigation-help")?.textContent,
    ).toBe(
      "There is one product highlight, so automatic rotation is unavailable.",
    );

    click(currentDot);
    expect(showcase().dataset.autoplay).toBe("off");
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Automatic rotation is unavailable because there is only one slide.",
    );
    advance(AUTH_SHOWCASE_INTERVAL_MS * 2);
    expectActive("Campaigns");
  });

  it("removes media, visibility, window listeners, and its timer on unmount", () => {
    const removeVisibility = vi.spyOn(document, "removeEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    render(<AuthShowcase slides={SLIDES} />);

    expect(motionListeners.size).toBe(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();

    expect(motionListeners.size).toBe(0);
    expect(removeVisibility).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(removeWindow).toHaveBeenCalledWith("blur", expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves form value, node identity, and focus while AuthShell rotates", () => {
    render(
      <AuthShell
        illustration="/static.webp"
        showcaseSlides={SLIDES}
        heading="Sign in to Moosewave"
        headingSub="Use your account credentials."
        footer={<></>}
      >
        <form>
          <label htmlFor="showcase-email">Email</label>
          <input
            id="showcase-email"
            type="email"
            defaultValue="qa@example.test"
          />
        </form>
      </AuthShell>,
    );
    const originalInput =
      document.querySelector<HTMLInputElement>("#showcase-email");
    if (!originalInput) throw new Error("Missing auth input");
    originalInput.value = "person@example.test";
    act(() => originalInput.focus());

    advance(AUTH_SHOWCASE_INTERVAL_MS);
    expectActive("Audience");
    const currentInput =
      document.querySelector<HTMLInputElement>("#showcase-email");
    expect(currentInput).toBe(originalInput);
    expect(currentInput?.value).toBe("person@example.test");
    expect(document.activeElement).toBe(originalInput);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelectorAll("h2")).toHaveLength(SLIDES.length);
    expect(document.querySelector("h1")?.textContent).toBe(
      "Sign in to Moosewave",
    );
    const main = document.querySelector(".auth-main");
    const aside = document.querySelector(".auth-aside-showcase");
    expect(
      main!.compareDocumentPosition(aside!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      document
        .querySelector(".auth-aside-showcase")
        ?.hasAttribute("aria-hidden"),
    ).toBe(false);
  });

  it("keeps the non-rotating aside decorative while retaining one real h1", () => {
    render(
      <AuthShell
        illustration="/static.webp"
        asideHeadline="A decorative static message"
        heading="Reset your password"
        footer={<></>}
      >
        <p>Reset instructions</p>
      </AuthShell>,
    );

    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("h1")?.textContent).toBe(
      "Reset your password",
    );
    expect(
      document.querySelector(".auth-aside")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("defaults to legal navigation without unscoped deployment claims", () => {
    render(
      <AuthShell illustration="/static.webp" heading="Reset your password">
        <p>Reset instructions</p>
      </AuthShell>,
    );

    expect(
      document.querySelector('nav[aria-label="Legal and support"]'),
    ).not.toBeNull();
    for (const claim of [
      "TLS transport",
      "MFA available",
      "Revocable sessions",
      "Audit logging",
    ]) {
      expect(container?.textContent).not.toContain(claim);
    }
  });

  it("has no serious or critical automated accessibility violations", async () => {
    vi.useRealTimers();
    render(
      <AuthShell
        illustration="/static.webp"
        showcaseSlides={SLIDES}
        heading="Sign in to Moosewave"
        headingSub="Use your account credentials."
        footer={<></>}
      >
        <form>
          <label htmlFor="axe-auth-email">Email</label>
          <input id="axe-auth-email" type="email" />
          <button type="submit">Sign in</button>
        </form>
      </AuthShell>,
    );

    const result = await axe.run(container!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
