// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Render coverage for RichTextEditor — the inline-run editor every rich-text
// field in the semantic block editor is built from.
//
// WHY THIS FILE EXISTS. The editor is reachable (NodeProperties renders it,
// and the block editor renders that), but every tree the block editor's own
// suite produces comes from createNode(), and createNode only ever emits a
// single `text` run. So five of the six members of the inline union — strong,
// emphasis, link, slot, line_break — had never been rendered by anything, none
// of the six "+ kind" buttons had been pressed, and the kind-replacement rule
// that is the whole reason runOfKind exists was unexercised. v8 measured
// rich-text-editor at 29% of statements and 22% of branches.
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { RichTextEditor } from "@/components/semantic-email/rich-text-editor";
import {
  INLINE_KINDS,
  type Diagnostic,
  type InlineRun,
  type RichText,
} from "@/lib/semantic-email/types";

import { clickEveryControl, renderPage, unmount } from "../pages/_harness";

const POINTER = "/nodes/0/content/paragraph/text";

function run(overrides: Partial<InlineRun> & { kind: string }): InlineRun {
  return {
    text: "",
    url: "",
    accessible_label: "",
    slot: null,
    ...overrides,
  };
}

/** One run of every kind — the shape the block editor's own suite never builds. */
const EVERY_KIND: InlineRun[] = [
  run({ kind: "text", text: "plain" }),
  run({ kind: "strong", text: "bold" }),
  run({ kind: "emphasis", text: "italic" }),
  run({ kind: "link", text: "Read more", url: "https://example.com/x", accessible_label: "Read the guide" }),
  run({
    kind: "slot",
    slot: { id: "first_name", semantic_class: "name", required: true, fallback: "there" },
  }),
  run({ kind: "line_break" }),
];

function Editor({
  value,
  diagnostics = [],
  onChange,
}: {
  value: RichText;
  diagnostics?: readonly Diagnostic[];
  onChange: (next: RichText) => void;
}) {
  return (
    <RichTextEditor
      label="Paragraph text"
      value={value}
      pointer={POINTER}
      diagnostics={diagnostics}
      idPrefix="rt"
      onChange={onChange}
    />
  );
}

function LiveEditor({ initial }: { initial: RichText }) {
  const [value, setValue] = useState(initial);
  return <Editor value={value} onChange={setValue} />;
}

function rows(container: HTMLElement): HTMLLIElement[] {
  return [...container.querySelectorAll("li")];
}

async function choose(select: HTMLSelectElement | null, value: string) {
  expect(select).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(select!, value);
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function press(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  expect(button, `button "${text}"`).toBeDefined();
  await act(async () => {
    button!.click();
  });
}

describe("semantic rich text editor", () => {
  it("renders one row per run, with only the fields that run's kind carries", async () => {
    const { text, container, root } = await renderPage(Editor, {
      value: { runs: EVERY_KIND },
      onChange: vi.fn(),
    });
    try {
      expect(text).toContain("Paragraph text");
      expect(rows(container)).toHaveLength(EVERY_KIND.length);

      // text / strong / emphasis: kind + text, nothing else. A URL box on a
      // strong run would be an inline_cardinality error the author never typed.
      for (const index of [0, 1, 2]) {
        const row = rows(container)[index];
        expect(row.querySelectorAll("select")).toHaveLength(1);
        expect(row.querySelectorAll("input")).toHaveLength(1);
      }
      expect(
        container.querySelector<HTMLInputElement>("#rt-run-1-text")!.value,
      ).toBe("bold");

      // link: text + URL + accessible label, and no slot.
      const link = rows(container)[3];
      expect(link.querySelectorAll("input")).toHaveLength(3);
      expect(
        container.querySelector<HTMLInputElement>("#rt-run-3-url")!.value,
      ).toBe("https://example.com/x");
      expect(
        container.querySelector<HTMLInputElement>("#rt-run-3-label")!.value,
      ).toBe("Read the guide");
      expect(container.querySelector("#rt-run-3-slot-id")).toBeNull();

      // slot: id + class + fallback + required, and no free text.
      expect(
        container.querySelector<HTMLInputElement>("#rt-run-4-slot-id")!.value,
      ).toBe("first_name");
      expect(
        container.querySelector<HTMLSelectElement>("#rt-run-4-slot-class")!.value,
      ).toBe("name");
      expect(
        container.querySelector<HTMLInputElement>("#rt-run-4-slot-fallback")!.value,
      ).toBe("there");
      expect(
        rows(container)[4].querySelector<HTMLInputElement>(
          'input[type="checkbox"]',
        )!.checked,
      ).toBe(true);
      expect(container.querySelector("#rt-run-4-text")).toBeNull();

      // line_break carries nothing at all.
      const brk = rows(container)[5];
      expect(brk.querySelectorAll("input")).toHaveLength(0);
      expect(brk.querySelectorAll("select")).toHaveLength(1);
    } finally {
      unmount(root);
    }
  });

  it("offers an add button for every member of the inline union", async () => {
    const onChange = vi.fn();
    const { container, root } = await renderPage(Editor, {
      value: { runs: [run({ kind: "text", text: "plain" })] },
      onChange,
    });
    try {
      const adders = [...container.querySelectorAll("button")].filter((button) =>
        button.textContent?.startsWith("+ "),
      );
      expect(adders.map((button) => button.textContent)).toEqual([
        "+ Text",
        "+ Strong",
        "+ Emphasis",
        "+ Link",
        "+ Slot",
        "+ Line break",
      ]);
      expect(adders).toHaveLength(INLINE_KINDS.length);

      await press(container, "+ Link");
      const afterLink = onChange.mock.calls.at(-1)![0] as RichText;
      expect(afterLink.runs).toHaveLength(2);
      expect(afterLink.runs[1]).toEqual({
        kind: "link",
        text: "New text",
        url: "",
        accessible_label: "",
        slot: null,
      });

      // A slot run is born with a slot, not with a null one to be discovered
      // later as an inline_cardinality error.
      await press(container, "+ Slot");
      const afterSlot = onChange.mock.calls.at(-1)![0] as RichText;
      expect(afterSlot.runs[1]).toEqual({
        kind: "slot",
        text: "",
        url: "",
        accessible_label: "",
        slot: { id: "", semantic_class: "text", required: false, fallback: "" },
      });

      await press(container, "+ Line break");
      const afterBreak = onChange.mock.calls.at(-1)![0] as RichText;
      expect(afterBreak.runs[1]).toEqual({
        kind: "line_break",
        text: "",
        url: "",
        accessible_label: "",
        slot: null,
      });
    } finally {
      unmount(root);
    }
  });

  it("replaces a run when its kind changes rather than patching it", async () => {
    // The inline union is closed. Patching in place would leave the previous
    // kind's payload behind — a "text" run still carrying a URL — which is an
    // inline_cardinality error the author never typed and cannot see.
    const onChange = vi.fn();
    const { container, root } = await renderPage(Editor, {
      value: {
        runs: [
          run({ kind: "link", text: "Read more", url: "https://example.com/x", accessible_label: "Read the guide" }),
        ],
      },
      onChange,
    });
    try {
      await choose(
        container.querySelector<HTMLSelectElement>("#rt-run-0-kind"),
        "text",
      );
      expect((onChange.mock.calls.at(-1)![0] as RichText).runs[0]).toEqual({
        kind: "text",
        text: "Read more",
        url: "",
        accessible_label: "",
        slot: null,
      });

      // And going the other way drops the text instead of carrying it into a
      // slot run, which may only carry a declaration.
      await choose(
        container.querySelector<HTMLSelectElement>("#rt-run-0-kind"),
        "slot",
      );
      expect((onChange.mock.calls.at(-1)![0] as RichText).runs[0]).toEqual({
        kind: "slot",
        text: "",
        url: "",
        accessible_label: "",
        slot: { id: "", semantic_class: "text", required: false, fallback: "" },
      });
    } finally {
      unmount(root);
    }
  });

  it("reorders runs and disables the move that would fall off the end", async () => {
    const initial: RichText = {
      runs: [
        run({ kind: "text", text: "first" }),
        run({ kind: "strong", text: "second" }),
        run({ kind: "emphasis", text: "third" }),
      ],
    };
    const { container, root } = await renderPage(LiveEditor, { initial });
    try {
      const up = (index: number) =>
        rows(container)[index].querySelector<HTMLButtonElement>(
          'button[aria-label$="up"]',
        )!;
      const down = (index: number) =>
        rows(container)[index].querySelector<HTMLButtonElement>(
          'button[aria-label$="down"]',
        )!;

      expect(up(0).disabled).toBe(true);
      expect(down(2).disabled).toBe(true);
      expect(up(2).disabled).toBe(false);

      await act(async () => {
        up(2).click();
      });
      expect(
        rows(container).map(
          (row) => row.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')?.value,
        ),
      ).toEqual(["first", "third", "second"]);

      await act(async () => {
        rows(container)[0]
          .querySelector<HTMLButtonElement>('button[aria-label^="Remove"]')!
          .click();
      });
      expect(rows(container)).toHaveLength(2);
    } finally {
      unmount(root);
    }
  });

  it("names each row's buttons by position, so runs of one kind stay distinguishable", async () => {
    // The buttons used to be named from the run's KIND, so three text runs
    // produced nine buttons carrying only three distinct names ("Move Text run
    // up" ×3). A screen-reader user could hear which button they were on and
    // still not know which run it would act on.
    const { container, root } = await renderPage(Editor, {
      value: {
        runs: [
          run({ kind: "text", text: "first" }),
          run({ kind: "text", text: "second" }),
          run({ kind: "text", text: "third" }),
        ],
      },
      onChange: vi.fn(),
    });
    try {
      const labels = [
        ...container.querySelectorAll<HTMLButtonElement>("li button"),
      ].map((button) => button.getAttribute("aria-label"));
      expect(labels).toHaveLength(9);
      expect(new Set(labels).size).toBe(9);
      // The ordinal is the row's position, the same way the row's inputs are
      // addressed by position (#rt-run-1-text).
      expect(labels).toEqual([
        "Move Text run 1 up",
        "Move Text run 1 down",
        "Remove Text run 1",
        "Move Text run 2 up",
        "Move Text run 2 down",
        "Remove Text run 2",
        "Move Text run 3 up",
        "Move Text run 3 down",
        "Remove Text run 3",
      ]);
    } finally {
      unmount(root);
    }
  });

  it("offers a way out of a slot run whose declaration is missing", async () => {
    // decode.ts maps a wire run with a missing or null slot to exactly this
    // shape, so it is what an imported document can contain. The row used to
    // render its kind picker and nothing else: uneditable, with no account of
    // why it was empty.
    const initial: RichText = { runs: [run({ kind: "slot", slot: null })] };
    const { container, root } = await renderPage(LiveEditor, { initial });
    try {
      expect(container.querySelector("#rt-run-0-slot-id")).toBeNull();
      expect(container.textContent).toContain("no slot declaration");

      const repair = [
        ...container.querySelectorAll<HTMLButtonElement>("li button"),
      ].find((button) => button.textContent === "Add slot declaration");
      expect(repair, "the repair control for a slot run with no slot").toBeDefined();
      await act(async () => {
        repair!.click();
      });

      // The row is editable afterwards, and the declaration is the same empty
      // one "+ Slot" mints rather than a half-populated guess.
      expect(
        container.querySelector<HTMLInputElement>("#rt-run-0-slot-id")!.value,
      ).toBe("");
      expect(
        container.querySelector<HTMLSelectElement>("#rt-run-0-slot-class")!.value,
      ).toBe("text");
      expect(
        container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
          .checked,
      ).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("shows a run's diagnostic on that run and marks its kind invalid", async () => {
    const diagnostics: Diagnostic[] = [
      {
        severity: "error",
        code: "inline_cardinality",
        path: `${POINTER}/runs/1`,
        message: "link runs require text and URL, and must not contain a slot",
      },
      {
        severity: "error",
        code: "invalid_url",
        path: `${POINTER}/runs/1/url`,
        message: "URL is not absolute",
      },
    ];
    const { container, root } = await renderPage(Editor, {
      value: {
        runs: [
          run({ kind: "text", text: "fine" }),
          run({ kind: "link", text: "broken", url: "not-a-url" }),
        ],
      },
      diagnostics,
      onChange: vi.fn(),
    });
    try {
      // The message lands on the run it addresses, not in a summary above.
      expect(rows(container)[1].textContent).toContain(
        "link runs require text and URL",
      );
      expect(rows(container)[0].textContent).not.toContain(
        "link runs require text and URL",
      );
      // The kind select carries the run-level error (subtree match), the URL
      // box carries its own.
      expect(
        container.querySelector("#rt-run-1-kind")!.getAttribute("aria-invalid"),
      ).toBe("true");
      expect(
        container.querySelector("#rt-run-1-url")!.getAttribute("aria-invalid"),
      ).toBe("true");
      expect(
        container.querySelector("#rt-run-0-kind")!.getAttribute("aria-invalid"),
      ).toBe("false");
    } finally {
      unmount(root);
    }
  });

  it("fires every enabled button, and every one of them is named", async () => {
    const onChange = vi.fn();
    const { container, root } = await renderPage(Editor, {
      value: { runs: EVERY_KIND },
      onChange,
    });
    try {
      const buttons = [...container.querySelectorAll("button")];
      const unnamed = buttons.filter(
        (button) =>
          (button.getAttribute("aria-label") ?? button.textContent ?? "").trim() ===
          "",
      );
      expect(unnamed.map((button) => button.outerHTML)).toEqual([]);

      const { clicked, failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
      // 6 add buttons + 3 per run × 6 runs, less the two disabled ends.
      expect(clicked).toBe(22);
      // Every button here is an edit; a button wired to nothing would part the
      // two counts.
      expect(onChange.mock.calls).toHaveLength(clicked);
    } finally {
      unmount(root);
    }
  });
});
