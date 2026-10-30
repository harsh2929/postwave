// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  TEMPLATE_PREVIEW_MAX_ELEMENTS,
  TEMPLATE_PREVIEW_MAX_HTML_CHARS,
  TemplatePreview,
} from "../../components/TemplatePreview";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(element: React.ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function previewDocument(frame: HTMLIFrameElement): Document {
  const source = frame.getAttribute("srcdoc") ?? "";
  return new DOMParser().parseFromString(source, "text/html");
}

const adversarialHtml = `
  <meta http-equiv="refresh" content="0;url=https://tracker.example/refresh">
  <base href="https://tracker.example/">
  <link rel="preload" href="https://tracker.example/preload" as="image">
  <script>top.location = "https://tracker.example/script"</script>
  <iframe src="https://tracker.example/frame"></iframe>
  <object data="https://tracker.example/object"></object>
  <a id="remote-link" href="https://tracker.example/click" target="_top"
     ping="https://tracker.example/ping" onclick="location.href='https://tracker.example/event'"
     tabindex="0" accesskey="x" draggable="true">Open</a>
  <form id="remote-form" action="https://tracker.example/form">
    <input id="form-control" formaction="https://tracker.example/override" autofocus>
  </form>
  <img id="remote-image" src="https://tracker.example/pixel.gif" srcset="https://tracker.example/2x 2x"
       onerror="fetch('https://tracker.example/error')">
  <img id="embedded-image" src="data:image/png;base64,iVBORw0KGgo=">
  <img id="blob-image" src="blob:https://postwave.test/local-id">
  <svg>
    <image id="svg-image" href="https://tracker.example/vector" />
    <a id="animated-link"><set attributeName="href" to="https://tracker.example/smil" /></a>
  </svg>
  <template shadowrootmode="open">
    <img id="shadow-image" src="https://tracker.example/shadow">
    <a id="shadow-link" href="https://tracker.example/shadow-click">Shadow</a>
  </template>
  <style>
    @import url("https://tracker.example/import.css");
    .remote-background { background-image: url("https://tracker.example/background.png"); }
    .embedded-background { background-image: url("data:image/png;base64,iVBORw0KGgo="); }
    @font-face { font-family: Embedded; src: url("data:font/woff2;base64,d09GMgAB"); }
  </style>
  <div id="inline-style" style="background:url('https://tracker.example/inline.png'); border-image-source:url(data:image/png;base64,iVBORw0KGgo=)">Styled</div>
`;

describe("TemplatePreview security maturity", () => {
  it("isolates the full preview before adversarial markup and discloses the safety model", async () => {
    const surface = render(<TemplatePreview html={adversarialHtml} />);
    const frame = surface.querySelector<HTMLIFrameElement>("iframe");
    expect(frame).not.toBeNull();
    if (!frame) throw new Error("Template preview iframe was not rendered");

    expect(frame.title).toBe("Template preview");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-");
    expect(frame.referrerPolicy).toBe("no-referrer");
    expect(frame.getAttribute("allow")).toContain("camera 'none'");
    expect(frame.getAttribute("allow")).toContain("clipboard-read 'none'");
    expect(frame.getAttribute("allow")).toContain("payment 'none'");

    const disclosure = surface.querySelector<HTMLParagraphElement>("p");
    expect(disclosure?.textContent).toContain("external assets");
    expect(disclosure?.textContent).toContain("tracking requests are blocked");
    expect(frame.getAttribute("aria-describedby")).toBe(disclosure?.id);

    const source = frame.getAttribute("srcdoc") ?? "";
    const cspPosition = source.indexOf(
      '<meta http-equiv="Content-Security-Policy"',
    );
    expect(cspPosition).toBeGreaterThan(-1);
    expect(cspPosition).toBeLessThan(source.indexOf("<style>"));
    expect(cspPosition).toBeLessThan(source.indexOf("<body>"));
    expect(source).toContain("default-src 'none'");
    expect(source).toContain("img-src data: blob:");
    expect(source).toContain("connect-src 'none'");
    expect(source).toContain("form-action 'none'");
    expect(source).toContain("navigate-to 'none'");
    expect(source).toContain("script-src 'none'");
    expect(source).toContain('name="referrer" content="no-referrer"');

    const isolated = previewDocument(frame);
    expect(
      isolated.querySelector("script,iframe,object,base,link,animate,set"),
    ).toBeNull();
    expect(isolated.querySelector('meta[http-equiv="refresh"]')).toBeNull();

    const link = isolated.querySelector("#remote-link");
    expect(link?.hasAttribute("href")).toBe(false);
    expect(link?.hasAttribute("target")).toBe(false);
    expect(link?.hasAttribute("ping")).toBe(false);
    expect(link?.hasAttribute("onclick")).toBe(false);
    expect(link?.hasAttribute("accesskey")).toBe(false);
    expect(link?.hasAttribute("draggable")).toBe(false);
    expect(link?.getAttribute("role")).toBe("link");
    expect(link?.getAttribute("aria-disabled")).toBe("true");
    expect(link?.getAttribute("tabindex")).toBe("-1");

    const form = isolated.querySelector("#remote-form");
    const control = isolated.querySelector("#form-control");
    expect(form?.hasAttribute("action")).toBe(false);
    expect(form?.getAttribute("aria-disabled")).toBe("true");
    expect(control?.hasAttribute("formaction")).toBe(false);
    expect(control?.hasAttribute("autofocus")).toBe(false);
    expect(control?.hasAttribute("disabled")).toBe(true);

    const remoteImage = isolated.querySelector("#remote-image");
    expect(remoteImage?.hasAttribute("src")).toBe(false);
    expect(remoteImage?.hasAttribute("srcset")).toBe(false);
    expect(remoteImage?.hasAttribute("onerror")).toBe(false);
    expect(isolated.querySelector("#embedded-image")?.getAttribute("src")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(isolated.querySelector("#blob-image")?.getAttribute("src")).toBe(
      "blob:https://postwave.test/local-id",
    );
    expect(isolated.querySelector("#svg-image")?.hasAttribute("href")).toBe(
      false,
    );

    const nested = isolated.querySelector<HTMLTemplateElement>("template");
    expect(nested?.hasAttribute("shadowrootmode")).toBe(false);
    expect(
      nested?.content.querySelector("#shadow-image")?.hasAttribute("src"),
    ).toBe(false);
    expect(
      nested?.content.querySelector("#shadow-link")?.hasAttribute("href"),
    ).toBe(false);

    // A second layer removes remote CSS endpoints even though the earliest
    // CSP would independently prevent those requests.
    const styles = Array.from(isolated.querySelectorAll("style"))
      .map((style) => style.textContent)
      .join("\n");
    expect(styles).not.toContain("https://tracker.example/import.css");
    expect(styles).not.toContain("https://tracker.example/background.png");
    expect(styles).toContain("data:image/png;base64,iVBORw0KGgo=");
    expect(styles).toContain("data:font/woff2;base64,d09GMgAB");
    const inlineStyle = isolated
      .querySelector("#inline-style")
      ?.getAttribute("style");
    expect(inlineStyle).not.toContain("https://tracker.example/inline.png");
    expect(inlineStyle).toContain("data:image/png;base64,iVBORw0KGgo=");

    // happy-dom cannot expose a messageable iframe window to axe. The frame's
    // title, description, sandbox, and policy are asserted above; audit the
    // surrounding rendered surface without that test-environment limitation.
    frame.remove();
    const result = await axe.run(surface);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("HTML-escapes every interpolated value before parsing or attribute hardening", () => {
    const inheritedVariables = {
      inherited: '<img id="prototype-injection" src="https://evil.test/p">',
    };
    const variables = Object.assign(Object.create(inheritedVariables), {
      copy: '<img id="copy-injection" src="https://evil.test/c"> & "quoted"',
      endpoint: 'x" onmouseover="location.href=`https://evil.test/move`',
      css: '</style><img id="style-injection" src="https://evil.test/s">',
      unquoted: "sample onload=location.href='https://evil.test/unquoted'",
    }) as Record<string, string>;
    const surface = render(
      <TemplatePreview
        html={`
          <p id="copy">{{copy}}</p>
          <p id="inherited">{{inherited}}</p>
          <a id="variable-link" href="https://evil.test/{{endpoint}}">Link</a>
          <div id="unquoted-variable" data-preview={{unquoted}}>Attribute sample</div>
          <style>.sample::after { content: "{{css}}"; }</style>
        `}
        variables={variables}
      />,
    );
    const frame = surface.querySelector<HTMLIFrameElement>("iframe");
    if (!frame) throw new Error("Template preview iframe was not rendered");
    const isolated = previewDocument(frame);

    expect(isolated.querySelector("#copy")?.textContent).toBe(
      '<img id="copy-injection" src="https://evil.test/c"> & "quoted"',
    );
    expect(isolated.querySelector("#copy-injection")).toBeNull();
    expect(isolated.querySelector("#style-injection")).toBeNull();
    expect(isolated.querySelector("#prototype-injection")).toBeNull();
    expect(isolated.querySelector("#inherited")?.textContent).toBe(
      "{{inherited}}",
    );
    expect(isolated.querySelector("#variable-link")?.hasAttribute("href")).toBe(
      false,
    );
    expect(isolated.querySelector("[onmouseover]")).toBeNull();
    const unquoted = isolated.querySelector("#unquoted-variable");
    expect(unquoted?.getAttribute("data-preview")).toBe(
      "sample onload=location.href='https://evil.test/unquoted'",
    );
    expect(unquoted?.hasAttribute("onload")).toBe(false);
  });

  it("replaces oversized HTML and excessive DOM complexity with a safe notice", () => {
    const oversized = render(
      <TemplatePreview
        html={`<p>${"x".repeat(TEMPLATE_PREVIEW_MAX_HTML_CHARS + 1)}</p>`}
      />,
    );
    const oversizedFrame = oversized.querySelector<HTMLIFrameElement>("iframe");
    if (!oversizedFrame) throw new Error("Missing oversized preview frame");
    let isolated = previewDocument(oversizedFrame);
    expect(
      isolated.querySelector('[data-pw-preview-limit="html"]')?.textContent,
    ).toContain("too complex for the safe desktop preview");
    expect(isolated.querySelectorAll("p")).toHaveLength(1);

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    const excessiveElements = Array.from(
      { length: TEMPLATE_PREVIEW_MAX_ELEMENTS + 1 },
      () => "<i></i>",
    ).join("");
    const excessive = render(<TemplatePreview html={excessiveElements} />);
    const excessiveFrame = excessive.querySelector<HTMLIFrameElement>("iframe");
    if (!excessiveFrame) throw new Error("Missing excessive preview frame");
    isolated = previewDocument(excessiveFrame);
    expect(
      isolated.querySelector('[data-pw-preview-limit="elements"]')?.textContent,
    ).toContain("too complex for the safe desktop preview");
    expect(isolated.querySelectorAll("i")).toHaveLength(0);
  });
});
