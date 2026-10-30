// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Event-count rules saved before the { count, days } shape store a bare
// number. The compiler (compile.go parseMetricValue + the in_last_days /
// more_than_days_ago cases, pinned by compile_metric_test.go) reads it as the
// window under a window comparator and as the all-time count threshold under
// the others. The builder must show that number in the control that means the
// same thing, and must not carry a value across comparator families where its
// meaning would silently change.
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ValueInput } from "@/components/segments/value-input";
import {
  registryToFieldDefs,
  retargetValue,
  valueFits,
} from "@/components/segments/segment-catalogue";
import type {
  Comparator,
  PredicateDefinition,
  SegmentCondition,
} from "@/lib/segments-api";
import registry from "../fixtures/segments/predicate-registry.json";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const FIELD = "metric.track.placed_order.count";
const recorded = registry.predicates as PredicateDefinition[];
const placedOrder = recorded.find((p) => p.key === FIELD)!;
// The registry emits one predicate per tracked event, keyed by its slug
// (registry.go normalizeRegistryKey); a second event has the same shape.
const [events, viewedProduct] = registryToFieldDefs([
  placedOrder,
  {
    ...placedOrder,
    key: "metric.track.viewed_product.count",
    label: "Viewed Product count",
    source_ref: "Viewed Product",
  },
]);

let mounted: { host: HTMLElement; root: Root } | null = null;

afterEach(() => {
  if (mounted) {
    const { host, root } = mounted;
    act(() => root.unmount());
    host.remove();
    mounted = null;
  }
});

function mount(comparator: Comparator, initial: SegmentCondition["value"]) {
  const seen: SegmentCondition["value"][] = [];
  function Harness() {
    const [value, setValue] = useState(initial);
    return createElement(ValueInput, {
      kind: events!.kind,
      valueType: events!.valueType,
      eventName: events!.eventName,
      comparator,
      value,
      onChange: (next) => {
        seen.push(next);
        setValue(next);
      },
    });
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(Harness)));
  mounted = { host, root };
  return { host, seen };
}

function input(host: HTMLElement, label: string): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!el) throw new Error(`no input labelled ${label}`);
  return el;
}

async function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set?.call(el, value);
  await act(async () => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("event-count rules stored as a bare number", () => {
  it("the registry fixture carries the event-count predicate", () => {
    expect(events?.valueType).toBe("metric_aggregate");
  });

  it("a window comparator shows the bare number as its window", () => {
    const { host } = mount("in_last_days", 14);
    expect(input(host, "Days").value).toBe("14");
  });

  it("a count comparator shows the bare number as the count and keeps it when a window is added", async () => {
    const { host, seen } = mount("gte", 3);
    expect(input(host, "Count").value).toBe("3");
    await type(input(host, "Window in days (optional)"), "30");
    expect(seen.at(-1)).toEqual({
      count: 3,
      days: 30,
      event_name: "Placed Order",
    });
  });

  it("a value keeps its comparator only where it means the same thing", () => {
    // Bare numbers and bare counts would turn into a window of that many days.
    expect(valueFits("in_last_days", 3, events)).toBe(false);
    expect(valueFits("in_last_days", { count: 3 }, events)).toBe(false);
    // A window stays a window between the two window comparators.
    expect(valueFits("more_than_days_ago", { days: 14 }, events)).toBe(true);
    // Count comparators keep either compiled shape.
    expect(valueFits("lte", 3, events)).toBe(true);
    expect(valueFits("lte", { count: 3, days: 7 }, events)).toBe(true);
  });
});

describe("event spellings that share a slug", () => {
  it("are offered once, naming the spelling the registry lists first", () => {
    // Registries served before the API de-duplicated these listed one
    // predicate per spelling under the same key, most-tracked first.
    const fields = registryToFieldDefs([
      placedOrder,
      { ...placedOrder, source_ref: "placed order" },
    ]);
    expect(fields.map((f) => [f.value, f.eventName])).toEqual([
      [FIELD, "Placed Order"],
    ]);
  });
});

describe("moving an event-count rule to another field or comparator", () => {
  it("re-points a kept count at the new field's event", () => {
    expect(
      retargetValue(
        "gte",
        { count: 2, days: 30, event_name: "Placed Order" },
        viewedProduct,
      ),
    ).toEqual({ count: 2, days: 30, event_name: "Viewed Product" });
  });

  it("gives a bare threshold the object form that names the event", () => {
    expect(retargetValue("lte", 3, events)).toEqual({
      count: 3,
      event_name: "Placed Order",
    });
  });

  it("starts a window comparator from a named 30-day window", () => {
    expect(
      retargetValue("in_last_days", { count: 3, event_name: "x" }, events),
    ).toEqual({ days: 30, event_name: "Placed Order" });
  });

  it("drops the event name when the new field is not an event count", () => {
    expect(retargetValue("equals", "vip", undefined)).toBe("vip");
  });
});
