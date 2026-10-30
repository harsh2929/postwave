import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useRef,
} from "react";

import "../styles-choice-group.css";

export interface ChoiceGroupOption<Value extends string = string> {
  value: Value;
  label: ReactNode;
  /** Visible and programmatic reason, particularly for unavailable choices. */
  description?: ReactNode;
  disabled?: boolean;
  /** Remains focusable so the operator can discover the reason. */
  unavailable?: boolean;
  className?: string;
  dataTestId?: string;
}

interface ChoiceGroupProps<Value extends string> {
  legend: string;
  value: Value;
  options: readonly ChoiceGroupOption<Value>[];
  onChange: (value: Value) => void;
  className?: string;
  optionClassName?: string;
  disabled?: boolean;
  orientation?: "horizontal" | "vertical";
  style?: CSSProperties;
  dataTestId?: string;
}

/** A labelled, native-radio choice group for filters, modes and branches. */
export function ChoiceGroup<Value extends string>({
  legend,
  value,
  options,
  onChange,
  className,
  optionClassName,
  disabled = false,
  orientation = "horizontal",
  style,
  dataTestId,
}: ChoiceGroupProps<Value>): ReactElement {
  const id = useId();
  const inputRefs = useRef(new Map<Value, HTMLInputElement>());

  const move = (current: Value, direction: -1 | 1 | "first" | "last"): void => {
    const candidates = options.filter((option) => !option.disabled);
    if (candidates.length === 0) return;
    const currentIndex = candidates.findIndex((option) => option.value === current);
    const nextIndex =
      direction === "first"
        ? 0
        : direction === "last"
          ? candidates.length - 1
          : (currentIndex + direction + candidates.length) % candidates.length;
    const next = candidates[nextIndex];
    if (!next) return;
    inputRefs.current.get(next.value)?.focus();
    if (!next.unavailable && !disabled) onChange(next.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "radio") return;
    const current = target.value as Value;
    const previousKey = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
    const nextKey = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
    if (event.key === previousKey) move(current, -1);
    else if (event.key === nextKey) move(current, 1);
    else if (event.key === "Home") move(current, "first");
    else if (event.key === "End") move(current, "last");
    else if (
      (event.key === " " || event.key === "Enter") &&
      target.getAttribute("aria-disabled") === "true"
    ) {
      event.preventDefault();
      return;
    } else return;
    event.preventDefault();
  };

  return (
    <fieldset
      className={`choice-group ${className ?? ""}`.trim()}
      disabled={disabled}
      data-orientation={orientation}
      data-testid={dataTestId}
      style={style}
    >
      <legend className="sr-only">{legend}</legend>
      {options.map((option, index) => {
        const descriptionId = option.description
          ? `${id}-choice-${index}-description`
          : undefined;
        return (
          <label
            key={option.value}
            className={`choice-group-option ${optionClassName ?? ""} ${option.className ?? ""}`.trim()}
            data-selected={value === option.value ? "true" : undefined}
            data-unavailable={option.unavailable ? "true" : undefined}
          >
            <input
              ref={(node) => {
                if (node) inputRefs.current.set(option.value, node);
                else inputRefs.current.delete(option.value);
              }}
              className="choice-group-input"
              data-testid={option.dataTestId}
              type="radio"
              name={`${id}-choice`}
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled}
              aria-disabled={option.unavailable || undefined}
              aria-describedby={descriptionId}
              onKeyDown={onKeyDown}
              onClick={(event) => {
                if (option.unavailable) event.preventDefault();
              }}
              onChange={() => {
                if (!option.unavailable) onChange(option.value);
              }}
            />
            <span className="choice-group-label">{option.label}</span>
            {option.description ? (
              <span id={descriptionId} className="choice-group-description">
                {option.description}
              </span>
            ) : null}
          </label>
        );
      })}
    </fieldset>
  );
}
