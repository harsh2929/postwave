// SPDX-License-Identifier: AGPL-3.0-only
//
// A form control with no accessible name is announced as "edit text" or
// "combo box" and nothing else. A screen-reader user hears the value and the
// role, never what the field is for, so a form becomes a row of anonymous
// boxes (WCAG 4.1.2). A placeholder does not fix it — it is a fallback in the
// accname chain, it disappears the moment the user types, and it is not what
// this app relies on anywhere.
//
// The rule: every <Input>, <Select>, <Textarea>, <Checkbox> and <Switch> must
// have a name computable from one of four sources — htmlFor+id, aria-label,
// aria-labelledby, or an enclosing <label>.
//
// This sweep found ZERO unlabelled controls across 611 usages. That is the
// finding, and this file exists to keep it true; it is not a report of debt.
// What it IS a report of is detector shape, because the naive version of this
// check accuses two controls and BOTH are correct code:
//
//   1. Ids threaded through props. suppressions/page.tsx has a local
//      `ReasonSelect({ id })` rendering <Select id={id}>. No literal id, no
//      htmlFor, nothing nameable in the tag — and both call sites pass
//      id="s-reason" / id="i-reason" against a <Label htmlFor> right above
//      them. The name is real, it just lives one component up.
//
//   2. Props spread onto the control. components/ui/password-input.tsx renders
//      <Input {...props} />, so id and aria-label arrive wholesale from the
//      caller. All six <PasswordInput> call sites pair an id with a Label.
//
// Rather than carve both out with a comment, the checker RESOLVES them: a
// control whose naming is delegated to the caller promotes its own component
// into the candidate set, and the same four rules then run at every call site.
// So <PasswordInput> is checked exactly as <Input> is, and a seventh call site
// added without a Label fails this test. A wrapper that delegates but has no
// call site to check is itself an offender — otherwise delegation would be a
// way to launder a nameless control past the sweep.
//
// One trap is worth naming because it is live in the tree. campaigns/[id]/ab/
// page.tsx carries a PROSE COMMENT containing "`<Label htmlFor={id}>` pointed
// at an element that never existed". An opening tag with no close, inside a
// comment, leaves a naive <label> depth counter stuck at 1 for the rest of the
// file and silently clears every control below it. Comments are stripped
// before any tag is counted, and a test below pins that.
//
// SCOPE, stated so this is not mistaken for a clean bill of health: it covers
// the five shared primitives, which is where this app puts its form controls.
// Raw <input>/<select>/<textarea> elements are a separate surface and are not
// swept here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

/** The shared primitives that render a real form control. */
const CONTROLS = ["Input", "Select", "Textarea", "Checkbox", "Switch"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/**
 * Blank out comments, preserving offsets so reported line numbers stay true.
 *
 * Only whole comment lines and braced JSX comment blocks are removed — never a
 * `//` found mid-line, which would eat the rest of a line containing a URL
 * along with any real JSX after it.
 */
function stripComments(text: string): string {
  const blank = (m: string) => " ".repeat(m.length);
  return text
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*\/|\*|\/\*)/.test(line) ? blank(line) : line))
    .join("\n");
}

/**
 * The full opening tag beginning at `start`.
 *
 * Depth-counts braces and skips string literals, so neither an arrow function
 * (`onChange={(e) => onChange(e.target.value)}` — note the `>` in `=>`) nor a
 * `title=">"` can end the tag early. Getting this wrong truncates the tag and
 * hides the very attributes the rules look for.
 */
function jsxTag(text: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const hasAttribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}=`).test(tag);

/** `id="value"` → "value". */
function attrLiteral(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/** `id={expr}` → "expr", brace-balanced so a nested template literal survives. */
function attrExpression(tag: string, name: string): string | null {
  const at = tag.search(new RegExp(`\\s${name}=\\{`));
  if (at < 0) return null;
  const start = tag.indexOf("{", at);
  let depth = 0;
  for (let i = start; i < tag.length; i++) {
    if (tag[i] === "{") depth++;
    else if (tag[i] === "}" && --depth === 0) return tag.slice(start + 1, i).trim();
  }
  return null;
}

/** How many <label>/<Label> elements are still open at `at`. */
function labelDepthAt(text: string, at: number): number {
  let depth = 0;
  const re = /<\/?[Ll]abel(?![A-Za-z0-9_])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && m.index < at) {
    if (m[0][1] === "/") depth--;
    else if (!jsxTag(text, m.index).endsWith("/>")) depth++;
  }
  return depth;
}

/** The component whose body encloses `at` — the one that would receive the props. */
function enclosingComponent(text: string, at: number): string | null {
  const re =
    /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:function\s+([A-Z]\w*)|const\s+([A-Z]\w*)\s*[:=])/g;
  let name: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && m.index < at) name = m[1] ?? m[2];
  return name;
}

type Tag = { component: string; index: number; tag: string };

function controlTags(text: string, components: readonly string[]): Tag[] {
  const out: Tag[] = [];
  for (const component of components) {
    const re = new RegExp(`<${component}(?![A-Za-z0-9_])`, "g");
    for (const m of text.matchAll(re)) {
      out.push({ component, index: m.index!, tag: jsxTag(text, m.index!) });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

type NameSource =
  | "aria-label"
  | "aria-labelledby"
  | "htmlFor-literal"
  | "htmlFor-expression"
  | "wrapped-in-label"
  | "delegated-to-caller"
  | null;

/**
 * Where this control's accessible name comes from, or null if nowhere.
 *
 * `text` must already be comment-stripped. htmlFor is matched file-wide rather
 * than by DOM adjacency — the same resolution rule aria-references-resolve.ts
 * uses, and the reason a name has to be unique per rendered tree, which that
 * sweep enforces separately.
 */
function nameSource(text: string, { tag, index }: Tag): NameSource {
  if (hasAttribute(tag, "aria-label")) return "aria-label";
  if (hasAttribute(tag, "aria-labelledby")) return "aria-labelledby";

  const literal = attrLiteral(tag, "id");
  if (literal && new RegExp(`htmlFor="${escapeRe(literal)}"`).test(text)) {
    return "htmlFor-literal";
  }
  const expression = attrExpression(tag, "id");
  if (
    expression &&
    new RegExp(`htmlFor=\\{\\s*${escapeRe(expression)}\\s*\\}`).test(text)
  ) {
    return "htmlFor-expression";
  }
  if (labelDepthAt(text, index) > 0) return "wrapped-in-label";

  // Nothing nameable here, but the caller may supply it: either an id this
  // component was handed (`id={id}`), or a wholesale `{...props}`. Neither can
  // be judged from this file, so the enclosing component is checked instead.
  if (expression) return "delegated-to-caller";
  if (/\{\.\.\.\s*\w+\s*\}/.test(tag)) return "delegated-to-caller";

  return null;
}

const FILES = walk(SRC);
const SOURCE = new Map(
  FILES.map((f) => [f, stripComments(readFileSync(f, "utf8"))] as const),
);

/**
 * The primitives, plus every component that delegates naming to its caller.
 *
 * Promoting a delegating wrapper is what makes the sweep sound: without it,
 * `<Input {...props} />` inside PasswordInput would be an unanswerable
 * accusation, and with it, every <PasswordInput> is held to the same four
 * rules the raw control is.
 */
function candidateComponents(): { components: string[]; delegating: string[] } {
  const components = new Set(CONTROLS);
  const delegating = new Set<string>();
  for (let round = 0; round < 6; round++) {
    let grew = false;
    for (const file of FILES) {
      const text = SOURCE.get(file)!;
      for (const t of controlTags(text, [...components])) {
        if (nameSource(text, t) !== "delegated-to-caller") continue;
        const owner = enclosingComponent(text, t.index);
        if (owner && !components.has(owner)) {
          components.add(owner);
          delegating.add(owner);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return { components: [...components], delegating: [...delegating] };
}

const { components: COMPONENTS, delegating: DELEGATING } = candidateComponents();

type Finding = { where: string; source: NameSource; component: string };

function findings(): Finding[] {
  const out: Finding[] = [];
  for (const file of FILES) {
    const text = SOURCE.get(file)!;
    for (const t of controlTags(text, COMPONENTS)) {
      const line = text.slice(0, t.index).split("\n").length;
      out.push({
        where: `${relative(SRC, file)}:${line}`,
        source: nameSource(text, t),
        component: t.component,
      });
    }
  }
  return out;
}

const FINDINGS = findings();

/** Every `<Component` usage in the corpus, for the delegation soundness check. */
function usageCount(component: string): number {
  const re = new RegExp(`<${component}(?![A-Za-z0-9_])`, "g");
  return FILES.reduce(
    (n, f) => n + [...SOURCE.get(f)!.matchAll(re)].length,
    0,
  );
}

/**
 * Controls excluded with a stated reason.
 *
 * Empty, and empty on purpose: both cases that a first pass would have carved
 * out here turned out to be correct code, and are resolved by the rules above
 * instead. The map and its staleness test stay wired so the next genuinely
 * unresolvable case has somewhere honest to go — keyed by "path:line".
 */
const EXCLUDED: Record<string, string> = {};

describe("form controls have a computable accessible name", () => {
  it("scans a non-trivial corpus", () => {
    // Vacuity floor: a broken walk or a truncating tag parser would make every
    // rule below pass for free.
    expect(FILES.length).toBeGreaterThan(400);
    expect(FINDINGS.length).toBeGreaterThan(450);
    expect(new Set(FINDINGS.map((f) => f.component)).size).toBeGreaterThan(3);
  });

  it("keeps all four name sources in use", () => {
    // Second vacuity floor, and the one that catches a rule going silent. If
    // any single source collapses to zero, either the app changed shape or the
    // matcher broke — and a broken matcher shows up as a flood of accusations
    // rather than a quiet pass only because these counts hold.
    const count = (s: NameSource) =>
      FINDINGS.filter((f) => f.source === s).length;
    expect(count("aria-label")).toBeGreaterThan(60);
    expect(count("htmlFor-literal")).toBeGreaterThan(200);
    expect(count("htmlFor-expression")).toBeGreaterThan(50);
    expect(count("wrapped-in-label")).toBeGreaterThan(40);
  });

  it("still fires on a genuinely unlabelled control", () => {
    // Guard the guard. Without this, every assertion in this file is satisfied
    // by a checker that returns a name for everything.
    const bare = `<div><Input value={v} onChange={(e) => set(e.target.value)} placeholder="Search" /></div>`;
    expect(nameSource(bare, controlTags(bare, CONTROLS)[0])).toBeNull();

    // A placeholder is not a name, and neither is a title on a sibling.
    const titled = `<Textarea rows={4} placeholder="Notes" />`;
    expect(nameSource(titled, controlTags(titled, CONTROLS)[0])).toBeNull();
  });

  it("does not end a tag early on an arrow function or a quoted angle bracket", () => {
    // Guard the guard, parser edge: `=>` and `title=">"` both contain the
    // character that closes a tag. A truncated tag drops the aria-label that
    // follows it and turns correct code into an accusation.
    const arrow = `<Select onChange={(e) => pick(e.target.value)} aria-label="Reason" />`;
    expect(nameSource(arrow, controlTags(arrow, CONTROLS)[0])).toBe("aria-label");

    const quoted = `<Input title=">" aria-labelledby="hint" />`;
    expect(nameSource(quoted, controlTags(quoted, CONTROLS)[0])).toBe(
      "aria-labelledby",
    );
  });

  it("accepts htmlFor, an enclosing label, and a threaded id", () => {
    // Guard the guard, the three shapes this app actually uses.
    const paired = `<Label htmlFor="s-email">Email</Label><Input id="s-email" />`;
    expect(nameSource(paired, controlTags(paired, CONTROLS)[0])).toBe(
      "htmlFor-literal",
    );

    const wrapped = `<label className="flex gap-2"><Checkbox checked={on} /><span>Archived</span></label>`;
    expect(nameSource(wrapped, controlTags(wrapped, CONTROLS)[0])).toBe(
      "wrapped-in-label",
    );

    const threaded = `<Select id={id} value={value} />`;
    expect(nameSource(threaded, controlTags(threaded, CONTROLS)[0])).toBe(
      "delegated-to-caller",
    );

    const spread = `<Input ref={ref} className={cn(className)} {...props} />`;
    expect(nameSource(spread, controlTags(spread, CONTROLS)[0])).toBe(
      "delegated-to-caller",
    );
  });

  it("does not let a commented-out Label clear the controls below it", () => {
    // Guard the guard, and a live trap: campaigns/[id]/ab/page.tsx explains a
    // past bug in prose that contains `<Label htmlFor={id}>`. Counted, that
    // unclosed tag clears every control after it for the rest of the file.
    const trap = [
      "  // `<Label htmlFor={id}>` pointed at an element that never existed",
      "  return <Input value={v} />;",
    ].join("\n");
    expect(labelDepthAt(trap, trap.length)).toBe(1); // raw text is poisoned
    const clean = stripComments(trap);
    expect(labelDepthAt(clean, clean.length)).toBe(0);
    expect(nameSource(clean, controlTags(clean, CONTROLS)[0])).toBeNull();
    expect(clean.length).toBe(trap.length); // offsets preserved for line numbers
  });

  it("holds delegating wrappers to the same rules at their call sites", () => {
    // Guard the guard for the promotion step. If promotion silently stopped
    // working, these two wrappers' internal controls would still pass while
    // their call sites went unchecked — a nameless control with an alibi.
    //
    // Containment, not equality: a NEW delegating wrapper is a normal thing to
    // write, and it is already made safe by having its own call sites swept.
    // Failing the suite for it would be accusing correct code.
    expect(DELEGATING).toContain("PasswordInput");
    expect(DELEGATING).toContain("ReasonSelect");
    for (const wrapper of DELEGATING) expect(COMPONENTS).toContain(wrapper);
  });

  it("gives every delegating wrapper a call site to be checked at", () => {
    // A wrapper that hands naming to a caller it never has is a nameless
    // control with an alibi. Its own usages are what this sweep verifies, so
    // zero usages means nothing was verified.
    // `<Name` matches JSX usages only — a `function Name(` or
    // `const Name = forwardRef(` definition is not a match — so one usage is
    // one real call site.
    const unverifiable = DELEGATING.filter((w) => usageCount(w) < 1).sort();
    expect(unverifiable).toEqual([]);
  });

  it("names every form control", () => {
    const unnamed = FINDINGS.filter(
      (f) => f.source === null && EXCLUDED[f.where] === undefined,
    )
      .map((f) => `${f.where}: <${f.component}> has no accessible name`)
      .sort();
    expect(unnamed).toEqual([]);
  });

  it("keeps every exclusion real", () => {
    // An exclusion for a control that is now named excuses nothing and hides
    // the next real one behind it.
    const named = new Set(
      FINDINGS.filter((f) => f.source !== null).map((f) => f.where),
    );
    const gone = new Set(FINDINGS.map((f) => f.where));
    const stale = Object.keys(EXCLUDED)
      .filter((where) => named.has(where) || !gone.has(where))
      .sort();
    expect(stale).toEqual([]);
  });
});
