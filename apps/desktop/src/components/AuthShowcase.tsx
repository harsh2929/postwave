import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";

import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import {
  AUTH_SHOWCASE_INTERVAL_MS,
  type AuthShowcaseIcon,
  type AuthShowcaseSlide,
  type AuthShowcaseSlides,
} from "../lib/auth-showcase";
import { Icon, type IconName } from "./Icon";

interface AuthShowcaseProps {
  slides: AuthShowcaseSlides;
}

type SlideDirection = "forward" | "backward";
type AutomaticRotationUnavailableReason = "reduced-motion" | "single-slide";

const SHOWCASE_ICONS: Record<AuthShowcaseIcon, IconName> = {
  campaigns: "megaphone",
  audience: "users",
  sequences: "git-branch",
  deliverability: "shield-check",
  analytics: "chart-bars",
};

function ordinal(value: number): string {
  return String(value).padStart(2, "0");
}

function ShowcaseImages({
  slides,
  activeIndex,
}: {
  slides: AuthShowcaseSlides;
  activeIndex: number;
}): ReactElement {
  return (
    <div className="auth-showcase-images" aria-hidden="true">
      {slides.map((slide, index) => (
        <div
          key={slide.id}
          className={`auth-showcase-image${index === activeIndex ? " is-active" : ""}`}
          style={{ backgroundImage: `url(${slide.illustration})` }}
        />
      ))}
    </div>
  );
}

function ShowcaseStory({
  slide,
  index,
  slideCount,
  active,
}: {
  slide: AuthShowcaseSlide;
  index: number;
  slideCount: number;
  active: boolean;
}): ReactElement {
  return (
    <div
      id={`auth-showcase-slide-${slide.id}`}
      className={`auth-showcase-copy${active ? " is-active" : ""}`}
      aria-hidden={!active}
      role={active ? "group" : undefined}
      aria-roledescription={active ? "slide" : undefined}
      aria-label={
        active ? `${slide.eyebrow}, ${index + 1} of ${slideCount}` : undefined
      }
    >
      <span className="auth-showcase-copy-glow" aria-hidden="true" />
      <div className="auth-showcase-meta">
        <span className="auth-showcase-meta-icon" aria-hidden="true">
          <Icon name={SHOWCASE_ICONS[slide.icon]} size={16} />
        </span>
        <span className="auth-showcase-meta-context">Product tour</span>
        <span className="auth-showcase-meta-divider" aria-hidden="true" />
        <span className="auth-aside-eyebrow">{slide.eyebrow}</span>
        <span className="auth-showcase-ordinal" aria-hidden="true">
          {ordinal(index + 1)} <i>/</i> {ordinal(slideCount)}
        </span>
      </div>

      <h2 className="auth-aside-headline">{slide.headline}</h2>
      <p className="auth-aside-sub">{slide.sub}</p>

      <div className="auth-showcase-capability-heading">
        <span>{slide.descriptor}</span>
        <span aria-hidden="true">
          {ordinal(slide.capabilities.length)} details
        </span>
      </div>
      <ul
        className="auth-showcase-capabilities"
        aria-label={`${slide.descriptor} capabilities`}
      >
        {slide.capabilities.map((capability, itemIndex) => (
          <li key={capability.label}>
            <span className="auth-showcase-capability-index" aria-hidden="true">
              {ordinal(itemIndex + 1)}
            </span>
            <span className="auth-showcase-capability-copy">
              <strong>{capability.label}</strong>
              <span>{capability.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ShowcaseStories({
  slides,
  activeIndex,
}: {
  slides: AuthShowcaseSlides;
  activeIndex: number;
}): ReactElement {
  return (
    <div className="auth-showcase-copy-stack">
      {slides.map((slide, index) => (
        <ShowcaseStory
          key={slide.id}
          slide={slide}
          index={index}
          slideCount={slides.length}
          active={index === activeIndex}
        />
      ))}
    </div>
  );
}

interface ShowcaseNavigationProps {
  slides: AuthShowcaseSlides;
  activeIndex: number;
  autoplayRequested: boolean;
  automaticRotationUnavailableReason?: AutomaticRotationUnavailableReason;
  setDotRef: (index: number, node: HTMLButtonElement | null) => void;
  onPointerDown: (index: number) => void;
  onPointerCancel: () => void;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>, index: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
}

function ShowcaseNavigation({
  slides,
  activeIndex,
  autoplayRequested,
  automaticRotationUnavailableReason,
  setDotRef,
  onPointerDown,
  onPointerCancel,
  onClick,
  onKeyDown,
}: ShowcaseNavigationProps): ReactElement {
  const automaticRotationAvailable =
    automaticRotationUnavailableReason === undefined;

  return (
    <div className="auth-showcase-pagination">
      <span id="auth-showcase-navigation-help" className="sr-only">
        {automaticRotationAvailable
          ? "Use Left and Right Arrow, Home, or End to choose a slide. Activating the current slide dot pauses or resumes automatic rotation."
          : automaticRotationUnavailableReason === "reduced-motion"
            ? "Use Left and Right Arrow, Home, or End to choose a slide. Automatic rotation is disabled by your reduced-motion preference."
            : "There is one product highlight, so automatic rotation is unavailable."}
      </span>
      <div
        className="auth-showcase-dots"
        role="group"
        aria-label="Choose a product highlight"
        aria-describedby="auth-showcase-navigation-help"
      >
        {slides.map((slide, index) => {
          const active = index === activeIndex;
          return (
            <button
              key={slide.id}
              ref={(node) => setDotRef(index, node)}
              type="button"
              className={`auth-showcase-dot${active ? " is-active" : ""}`}
              aria-label={
                active
                  ? automaticRotationAvailable
                    ? `${autoplayRequested ? "Pause" : "Resume"} automatic rotation. ${slide.eyebrow}, slide ${index + 1} of ${slides.length}.`
                    : automaticRotationUnavailableReason === "reduced-motion"
                      ? `${slide.eyebrow}, current slide ${index + 1} of ${slides.length}. Automatic rotation is disabled by reduced motion.`
                      : `${slide.eyebrow}, only slide. Automatic rotation is unavailable because there is only one slide.`
                  : automaticRotationAvailable
                    ? `Show ${slide.eyebrow}, slide ${index + 1} of ${slides.length}, and pause automatic rotation.`
                    : automaticRotationUnavailableReason === "reduced-motion"
                      ? `Show ${slide.eyebrow}, slide ${index + 1} of ${slides.length}. Automatic rotation remains off.`
                      : `Show ${slide.eyebrow}, the only slide.`
              }
              aria-current={active ? "true" : undefined}
              aria-controls={`auth-showcase-slide-${slide.id}`}
              tabIndex={active ? 0 : -1}
              onPointerDown={() => onPointerDown(index)}
              onPointerCancel={onPointerCancel}
              onClick={(event) => onClick(event, index)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <span className="auth-showcase-dot-track" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function AuthShowcase({ slides }: AuthShowcaseProps): ReactElement {
  const reducedMotion = usePrefersReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const [direction, setDirection] = useState<SlideDirection>("forward");
  const [autoplayRequested, setAutoplayRequested] = useState(
    () => !reducedMotion && slides.length > 1,
  );
  const [hoverPaused, setHoverPaused] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  const [windowActive, setWindowActive] = useState(() => document.hasFocus());
  const [focusWithin, setFocusWithin] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const dotRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pointerActivationRef = useRef<{
    index: number;
    autoplayRequested: boolean;
  } | null>(null);
  const slideCount = slides.length;
  const activeSlide = slides[activeIndex] ?? slides[0];
  const automaticRotationUnavailableReason:
    | AutomaticRotationUnavailableReason
    | undefined = reducedMotion
    ? "reduced-motion"
    : slideCount <= 1
      ? "single-slide"
      : undefined;
  const canRotate =
    !reducedMotion &&
    autoplayRequested &&
    !hoverPaused &&
    documentVisible &&
    windowActive &&
    !focusWithin &&
    slideCount > 1;

  useEffect(() => {
    if (reducedMotion) setAutoplayRequested(false);
  }, [reducedMotion]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, slideCount - 1));
    if (slideCount <= 1) setAutoplayRequested(false);
  }, [slideCount]);

  useEffect(() => {
    const onVisibilityChange = (): void => {
      setDocumentVisible(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    const onWindowBlur = (): void => setWindowActive(false);
    const onWindowFocus = (): void => setWindowActive(true);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, []);

  useEffect(() => {
    if (!canRotate) return;
    const timer = window.setTimeout(() => {
      setDirection("forward");
      setActiveIndex((current) => (current + 1) % slideCount);
    }, AUTH_SHOWCASE_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [activeIndex, canRotate, slideCount]);

  const showManualSlide = (
    index: number,
    requestedDirection?: SlideDirection,
  ): void => {
    const normalizedIndex = (index + slideCount) % slideCount;
    const nextSlide = slides[normalizedIndex] ?? slides[0];
    setDirection(
      requestedDirection ??
        (normalizedIndex < activeIndex ? "backward" : "forward"),
    );
    setActiveIndex(normalizedIndex);
    setAutoplayRequested(false);
    setAnnouncement(
      `${nextSlide.eyebrow}, slide ${normalizedIndex + 1} of ${slideCount}. ${
        automaticRotationUnavailableReason === "reduced-motion"
          ? "Automatic rotation remains off because reduced motion is enabled."
          : automaticRotationUnavailableReason === "single-slide"
            ? "Automatic rotation is unavailable because there is only one slide."
            : "Automatic rotation paused."
      }`,
    );
  };

  const handleFocusEnter = (event: FocusEvent<HTMLElement>): void => {
    setFocusWithin(true);
    const previousTarget = event.relatedTarget;
    if (
      previousTarget instanceof Node &&
      event.currentTarget.contains(previousTarget)
    ) {
      return;
    }
    setAutoplayRequested(false);
  };

  const handleFocusLeave = (event: FocusEvent<HTMLElement>): void => {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      event.currentTarget.contains(nextTarget)
    ) {
      return;
    }
    setFocusWithin(false);
  };

  const handleDotClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (index !== activeIndex) {
      pointerActivationRef.current = null;
      showManualSlide(index);
      return;
    }

    if (automaticRotationUnavailableReason !== undefined) {
      pointerActivationRef.current = null;
      setAutoplayRequested(false);
      setAnnouncement(
        automaticRotationUnavailableReason === "reduced-motion"
          ? "Automatic rotation remains off because reduced motion is enabled."
          : "Automatic rotation is unavailable because there is only one slide.",
      );
      return;
    }

    const pointerSnapshot = pointerActivationRef.current;
    const requestedBeforeActivation =
      event.detail > 0 && pointerSnapshot?.index === index
        ? pointerSnapshot.autoplayRequested
        : autoplayRequested;
    pointerActivationRef.current = null;
    const nextRequested = !requestedBeforeActivation;
    setAutoplayRequested(nextRequested);
    setAnnouncement(
      nextRequested
        ? "Automatic rotation enabled; it will resume when you leave slide navigation."
        : "Automatic slide rotation paused.",
    );
  };

  const handleDotKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (event.nativeEvent.isComposing) return;
    let nextIndex: number | null = null;
    let nextDirection: SlideDirection | undefined;
    if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + slideCount) % slideCount;
      nextDirection = "backward";
    }
    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % slideCount;
      nextDirection = "forward";
    }
    if (event.key === "Home") {
      nextIndex = 0;
      nextDirection = "backward";
    }
    if (event.key === "End") {
      nextIndex = slideCount - 1;
      nextDirection = "forward";
    }
    if (nextIndex === null) return;
    event.preventDefault();
    showManualSlide(nextIndex, nextDirection);
    dotRefs.current[nextIndex]?.focus();
  };

  return (
    <aside
      className={`auth-aside auth-aside-showcase tone-${activeSlide.tone}`}
      onMouseEnter={() => setHoverPaused(true)}
      onMouseLeave={() => setHoverPaused(false)}
      onFocusCapture={handleFocusEnter}
      onBlurCapture={handleFocusLeave}
    >
      <section
        className={`auth-showcase ${canRotate ? "is-rotating" : "is-paused"}`}
        style={
          {
            "--auth-showcase-cycle-duration": `${AUTH_SHOWCASE_INTERVAL_MS}ms`,
          } as CSSProperties
        }
        data-direction={direction}
        data-autoplay={autoplayRequested ? "on" : "off"}
        aria-roledescription="carousel"
        aria-label="Moosewave product highlights"
        aria-live="off"
      >
        <ShowcaseImages slides={slides} activeIndex={activeIndex} />
        <ShowcaseStories slides={slides} activeIndex={activeIndex} />
        <ShowcaseNavigation
          slides={slides}
          activeIndex={activeIndex}
          autoplayRequested={autoplayRequested}
          automaticRotationUnavailableReason={
            automaticRotationUnavailableReason
          }
          setDotRef={(index, node) => {
            dotRefs.current[index] = node;
          }}
          onPointerDown={(index) => {
            pointerActivationRef.current = { index, autoplayRequested };
          }}
          onPointerCancel={() => {
            pointerActivationRef.current = null;
          }}
          onClick={handleDotClick}
          onKeyDown={handleDotKeyDown}
        />

        <span
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {announcement}
        </span>
      </section>
    </aside>
  );
}
