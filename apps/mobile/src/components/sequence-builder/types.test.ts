import { describe, expect, it } from "vitest";

import {
  canvasToWire,
  conditionTypeFromPredicate,
  countCanvasSteps,
  stepSummary,
  wireToCanvas,
  type CanvasStep,
} from "./types";

describe("mobile sequence wire contract", () => {
  it("serializes nested Voice steps with one-based positions", () => {
    const steps: CanvasStep[] = [
      {
        id: "email-1",
        type: "email",
        position: 0,
        subject: "Welcome",
        body: "Hello",
      },
      {
        id: "condition-1",
        type: "condition",
        position: 1,
        condition_type: "opened",
        yes_branch: [
          {
            id: "delay-1",
            type: "delay",
            position: 0,
            delay_value: 2,
            delay_unit: "hours",
          },
        ],
        no_branch: [],
      },
      { id: "tag-1", type: "tag_add", position: 2, tag: "engaged" },
    ];

    expect(canvasToWire(steps)).toEqual([
      {
        type: "email",
        position: 1,
        email: { subject: "Welcome", body: "Hello" },
      },
      {
        type: "condition",
        position: 2,
        condition: {
          predicate: "opened_previous",
          yes_branch: [
            {
              type: "delay",
              position: 1,
              delay: { seconds: 7200, value: 2, unit: "hours" },
            },
          ],
          no_branch: [],
        },
      },
      {
        type: "tag_add",
        position: 3,
        tag: { tag: "engaged" },
      },
    ]);
  });

  it("reads nested Voice payloads back into the canvas", () => {
    const canvas = wireToCanvas([
      {
        type: "condition",
        position: 1,
        condition: {
          predicate: "custom_property_eq",
          value: "plan:pro",
          yes_branch: [
            {
              type: "email",
              position: 1,
              email: { subject: "Pro", body: "Thanks" },
            },
          ],
          no_branch: [],
        },
      },
    ]);

    expect(canvas[0]).toMatchObject({
      type: "condition",
      position: 0,
      condition_type: "custom_property",
      condition_value: "plan:pro",
    });
    expect(canvas[0]?.yes_branch?.[0]).toMatchObject({
      type: "email",
      position: 0,
      subject: "Pro",
      body: "Thanks",
    });
  });
});

describe("condition predicates", () => {
  it("decodes both the v0.3 and the legacy flat vocabularies", () => {
    expect(conditionTypeFromPredicate("opened_previous")).toBe("opened");
    expect(conditionTypeFromPredicate("clicked_any")).toBe("clicked");
    // Legacy rows store the flat form; these used to decode to "opened".
    expect(conditionTypeFromPredicate("clicked")).toBe("clicked");
    expect(conditionTypeFromPredicate("tagged")).toBe("tagged");
    expect(conditionTypeFromPredicate("custom_property")).toBe(
      "custom_property",
    );
  });

  it("models product_event instead of mislabelling it as an open", () => {
    expect(conditionTypeFromPredicate("product_event")).toBe("product_event");
    expect(
      stepSummary({
        id: "c",
        type: "condition",
        position: 0,
        condition_type: "product_event",
        condition_value: "checkout.completed",
      }),
    ).toBe('When event "checkout.completed" fires');
  });

  it("reports an unrecognised predicate as unsupported, never as opened", () => {
    expect(conditionTypeFromPredicate("moon_phase_waxing")).toBe("unsupported");
    expect(
      stepSummary({
        id: "c",
        type: "condition",
        position: 0,
        condition_type: "unsupported",
        condition_predicate: "moon_phase_waxing",
      }),
    ).toBe('Condition "moon_phase_waxing" — not supported on mobile');
  });

  it("round-trips an unsupported predicate verbatim rather than rewriting it", () => {
    const canvas = wireToCanvas([
      {
        type: "condition",
        position: 1,
        condition: {
          predicate: "moon_phase_waxing",
          yes_branch: [],
          no_branch: [],
        },
      },
    ]);
    expect(canvas[0]?.condition_type).toBe("unsupported");
    expect(canvasToWire(canvas)[0]?.condition?.predicate).toBe(
      "moon_phase_waxing",
    );
  });
});

describe("email step round-trip", () => {
  it("preserves body_mjml, delay_seconds and A/B variants", () => {
    const wire = [
      {
        type: "email" as const,
        position: 1,
        email: {
          subject: "Welcome",
          body: "Hi",
          body_html: "<p>Hi</p>",
          body_mjml: "<mjml><mj-body/></mjml>",
          delay_seconds: 3600,
          template_id: "tpl_1",
          variants: [
            { key: "a", subject: "A", body: "A body", weight_bp: 5000 },
            { key: "b", subject: "B", body: "B body", weight_bp: 5000 },
          ],
        },
      },
    ];
    const canvas = wireToCanvas(wire);
    expect(canvas[0]?.body_mjml).toBe("<mjml><mj-body/></mjml>");
    expect(canvas[0]?.email_delay_seconds).toBe(3600);
    expect(canvas[0]?.variants).toHaveLength(2);

    // A PATCH replaces the whole steps array, so anything dropped here is
    // destroyed server-side.
    expect(canvasToWire(canvas)[0]?.email).toEqual(wire[0]?.email);
  });

  it("preserves body_mjml and delay_seconds from the LEGACY flat emails shape", () => {
    // The detail screen seeds from `emails` when `steps` is empty, and a
    // GeneratedEmail carries body_mjml/delay_seconds at the TOP level rather
    // than under `email`. Reading only the nested shape dropped both — and the
    // server nulls the `emails` projection as soon as a `steps` array is sent,
    // so the loss is permanent rather than recoverable.
    const legacyEmails = [
      {
        position: 1,
        subject: "Welcome",
        body: "Hi",
        body_html: "<p>Hi</p>",
        body_mjml: "<mjml><mj-body/></mjml>",
        delay_seconds: 86400,
      },
    ];

    const canvas = wireToCanvas(legacyEmails);
    expect(canvas[0]?.type).toBe("email");
    expect(canvas[0]?.body_mjml).toBe("<mjml><mj-body/></mjml>");
    expect(canvas[0]?.email_delay_seconds).toBe(86400);

    const roundTripped = canvasToWire(canvas)[0]?.email;
    expect(roundTripped?.body_mjml).toBe("<mjml><mj-body/></mjml>");
    expect(roundTripped?.delay_seconds).toBe(86400);
    expect(roundTripped?.subject).toBe("Welcome");
    expect(roundTripped?.body_html).toBe("<p>Hi</p>");
  });
});

describe("wireToCanvas hostile input", () => {
  it("degrades a non-array steps payload to an empty canvas", () => {
    expect(wireToCanvas(undefined)).toEqual([]);
    expect(wireToCanvas(null)).toEqual([]);
    expect(
      wireToCanvas("nope" as unknown as Parameters<typeof wireToCanvas>[0]),
    ).toEqual([]);
  });

  it("degrades a non-array branch to an empty branch instead of throwing", () => {
    const canvas = wireToCanvas([
      {
        type: "condition",
        position: 1,
        condition: {
          predicate: "opened_previous",
          yes_branch: "boom" as unknown as [],
          no_branch: null as unknown as [],
        },
      },
    ]);
    expect(canvas[0]?.yes_branch).toEqual([]);
    expect(canvas[0]?.no_branch).toEqual([]);
  });

  it("skips null entries in the steps array", () => {
    const canvas = wireToCanvas([
      null as unknown as { type: "exit"; position: number },
      { type: "exit", position: 1 },
    ]);
    expect(canvas).toHaveLength(1);
  });

  it("stops recursing past the depth ceiling rather than blowing the stack", () => {
    type Nested = { type: "condition"; position: number; condition: { predicate: string; yes_branch: Nested[]; no_branch: [] } };
    let deepest: Nested = {
      type: "condition",
      position: 1,
      condition: { predicate: "opened_previous", yes_branch: [], no_branch: [] },
    };
    for (let i = 0; i < 40; i += 1) {
      deepest = {
        type: "condition",
        position: 1,
        condition: {
          predicate: "opened_previous",
          yes_branch: [deepest],
          no_branch: [],
        },
      };
    }
    expect(() => wireToCanvas([deepest])).not.toThrow();
  });
});

describe("countCanvasSteps", () => {
  it("counts nested branch steps, which steps.length silently omits", () => {
    const steps: CanvasStep[] = [
      {
        id: "c1",
        type: "condition",
        position: 0,
        condition_type: "opened",
        yes_branch: [
          { id: "e1", type: "email", position: 0 },
          {
            id: "c2",
            type: "condition",
            position: 1,
            condition_type: "clicked",
            yes_branch: [{ id: "e2", type: "email", position: 0 }],
            no_branch: [],
          },
        ],
        no_branch: [{ id: "x1", type: "exit", position: 0 }],
      },
    ];
    expect(steps.length).toBe(1);
    expect(countCanvasSteps(steps)).toBe(5);
  });

  it("returns 0 for empty and non-array input", () => {
    expect(countCanvasSteps([])).toBe(0);
    expect(countCanvasSteps(undefined)).toBe(0);
  });
});
