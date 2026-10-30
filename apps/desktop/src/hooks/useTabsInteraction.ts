import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

export interface TabDescriptor<Value extends string = string> {
  value: Value;
  disabled?: boolean;
}

interface UseTabsInteractionOptions<Value extends string> {
  value: Value;
  items: readonly TabDescriptor<Value>[];
  onChange: (value: Value) => void;
  activation?: "automatic" | "manual";
  orientation?: "horizontal" | "vertical";
}

/**
 * Shared APG interaction/relationship contract for application tabsets.
 * Callers retain their existing visual classes and panel mounting policy.
 */
export function useTabsInteraction<Value extends string>({
  value,
  items,
  onChange,
  activation = "automatic",
  orientation = "horizontal",
}: UseTabsInteractionOptions<Value>) {
  const generatedId = useId();
  const listNodeRef = useRef<HTMLElement | null>(null);
  const [rovingValue, setRovingValue] = useState<Value>(value);
  const changeRef = useRef(onChange);
  const itemsRef = useRef(items);
  changeRef.current = onChange;
  itemsRef.current = items;

  const itemKey = (candidate: Value): string => encodeURIComponent(candidate);
  const itemId = (candidate: Value): string =>
    `${generatedId}-tab-${itemKey(candidate)}`;
  const panelId = (candidate: Value): string =>
    `${generatedId}-panel-${itemKey(candidate)}`;
  const enabled = items.filter((item) => !item.disabled);
  const selectedFallback = enabled.some((item) => item.value === value)
    ? value
    : enabled[0]?.value;
  const focusValue = enabled.some((item) => item.value === rovingValue)
    ? rovingValue
    : selectedFallback;
  const membershipKey = items
    .map((item) => `${item.value}:${item.disabled ? "0" : "1"}`)
    .join("\u0000");

  useEffect(() => {
    const current = itemsRef.current;
    const fallback = current.find((item) => !item.disabled)?.value;
    const selected = current.find(
      (item) => item.value === value && !item.disabled,
    )?.value;
    const nextRoving = selected ?? fallback;
    setRovingValue((currentRoving) =>
      current.some((item) => item.value === currentRoving && !item.disabled)
        ? currentRoving
        : (nextRoving ?? currentRoving),
    );
    if (selected === undefined && fallback !== undefined) {
      changeRef.current(fallback);
    }
  }, [membershipKey, value]);

  useEffect(() => {
    if (
      itemsRef.current.some((item) => item.value === value && !item.disabled)
    ) {
      setRovingValue(value);
    }
  }, [value]);

  const focusTab = (candidate: Value): void => {
    const target = document.getElementById(itemId(candidate));
    if (!(target instanceof HTMLElement)) return;
    // The app shell intentionally uses smooth document scrolling for reading,
    // but roving focus must settle before a manual Enter/Space activation.
    // Prevent the implicit focus scroll, then reveal the tab synchronously so
    // a following activation captures the user's actual settled position.
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: "instant" as ScrollBehavior,
    });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    const target = (event.target as Element | null)?.closest<HTMLElement>(
      '[role="tab"]',
    );
    if (!target || !listNodeRef.current?.contains(target)) return;
    const currentItems = itemsRef.current;
    const currentIndex = currentItems.findIndex(
      (item) => itemId(item.value) === target.id,
    );
    if (currentIndex < 0) return;
    const enabledItems = currentItems.filter((item) => !item.disabled);
    const enabledIndex = enabledItems.findIndex(
      (item) => item.value === currentItems[currentIndex]?.value,
    );
    const previousKey = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
    const nextKey = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
    let next: Value | undefined;
    if (event.key === "Home") next = enabledItems[0]?.value;
    else if (event.key === "End") next = enabledItems.at(-1)?.value;
    else if (event.key === previousKey && enabledItems.length > 0) {
      next =
        enabledItems[
          (enabledIndex - 1 + enabledItems.length) % enabledItems.length
        ]?.value;
    } else if (event.key === nextKey && enabledItems.length > 0) {
      next = enabledItems[(enabledIndex + 1) % enabledItems.length]?.value;
    } else if (
      activation === "manual" &&
      (event.key === "Enter" || event.key === " ")
    ) {
      event.preventDefault();
      const selected = currentItems[currentIndex];
      if (selected && !selected.disabled) changeRef.current(selected.value);
      return;
    } else return;
    if (next === undefined) return;
    event.preventDefault();
    focusTab(next);
    if (activation === "automatic") changeRef.current(next);
  };

  return {
    listRef: (node: HTMLElement | null): void => {
      listNodeRef.current = node;
    },
    listProps: {
      role: "tablist" as const,
      "aria-orientation":
        orientation === "vertical" ? ("vertical" as const) : undefined,
      onKeyDown,
    },
    getTabProps: (candidate: Value) => {
      const descriptor = items.find((item) => item.value === candidate);
      const disabled = descriptor ? Boolean(descriptor.disabled) : true;
      return {
        id: itemId(candidate),
        role: "tab" as const,
        "aria-selected": value === candidate,
        "aria-controls": panelId(candidate),
        "aria-disabled": disabled || undefined,
        tabIndex: !disabled && focusValue === candidate ? 0 : -1,
        onFocus: (): void => {
          if (!disabled) setRovingValue(candidate);
        },
        onClick: (): void => {
          if (!disabled) changeRef.current(candidate);
        },
      };
    },
    getPanelProps: (candidate: Value) => ({
      id: panelId(candidate),
      role: "tabpanel" as const,
      "aria-labelledby": itemId(candidate),
      hidden: value !== candidate,
      tabIndex: 0,
    }),
  };
}
