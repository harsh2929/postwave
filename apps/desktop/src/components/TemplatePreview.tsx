/**
 * TemplatePreview — sandboxed iframe that renders the actual
 * operator-authored HTML body. Replaces the fake-CSS-placeholder
 * thumbnails that the audit identified as the #1 discoverability
 * blocker on the Templates page.
 *
 * Three rendering knobs surfaced to the caller:
 *
 *   1. `device` — "desktop" (600px) or "mobile" (375px). Mirrors the
 *      industry-standard preview toggle in Mailchimp / Beehiiv /
 *      Customer.io.
 *   2. `dark` — wraps the body in a dark-mode rendering context so
 *      the operator can spot the "white logo on white background"
 *      class of bug before sending. The Apple Mail dark-mode open
 *      rate is large enough that this is no longer optional.
 *   3. `interpolate` — substitutes `{{var_name}}` placeholders from
 *      a key/value map (sample subscriber data) so the preview
 *      shows real content instead of raw merge syntax.
 *
 * Security model: previews are an untrusted-document boundary. The
 * iframe has an empty sandbox (a unique origin with no capabilities),
 * a no-referrer policy, and a deny-by-default CSP placed before any
 * operator markup. We also remove active/embed elements, HTML resource
 * endpoints, and ordinary CSS import/URL references, retaining only
 * embedded data/blob images and fonts. These layers stop remote pixels,
 * links, forms, meta refreshes, scripts, and malformed-markup bypasses.
 *
 * The iframe has its own document via `srcDoc`; the CSP is what makes
 * that document network-silent. We write a tight `<style>` block with
 * a CSS reset + Moosewave's neutral type stack so untyped templates
 * still look acceptable.
 */

import { type ReactElement, useId, useMemo } from "react";

import { ChoiceGroup } from "./ChoiceGroup";

export type PreviewDevice = "desktop" | "mobile";

interface TemplatePreviewProps {
  /** Raw HTML body (operator-authored). */
  html: string;
  /** Optional MJML — when present and html is empty, we render an
   *  apology card instead of a blank iframe (we don't have a
   *  client-side MJML compiler). */
  mjml?: string;
  /** Currently-selected device frame width. */
  device?: PreviewDevice;
  /** When true, renders body inside a dark-mode shell. */
  dark?: boolean;
  /** Optional map of {{var}} -> value used to interpolate the body. */
  variables?: Record<string, string>;
  /** Outer height in pixels; defaults to 480. */
  height?: number;
}

const DEVICE_WIDTH: Record<PreviewDevice, number> = {
  desktop: 600,
  mobile: 375,
};

const PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "child-src 'none'",
  "connect-src 'none'",
  "font-src data: blob:",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src data: blob:",
  "manifest-src 'none'",
  "media-src 'none'",
  "navigate-to 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "worker-src 'none'",
].join("; ");

const PREVIEW_PERMISSIONS = [
  "accelerometer 'none'",
  "attribution-reporting 'none'",
  "autoplay 'none'",
  "browsing-topics 'none'",
  "camera 'none'",
  "clipboard-read 'none'",
  "clipboard-write 'none'",
  "display-capture 'none'",
  "encrypted-media 'none'",
  "fullscreen 'none'",
  "geolocation 'none'",
  "gyroscope 'none'",
  "identity-credentials-get 'none'",
  "join-ad-interest-group 'none'",
  "local-fonts 'none'",
  "microphone 'none'",
  "midi 'none'",
  "payment 'none'",
  "publickey-credentials-get 'none'",
  "run-ad-auction 'none'",
  "screen-wake-lock 'none'",
  "serial 'none'",
  "storage-access 'none'",
  "usb 'none'",
  "web-share 'none'",
  "window-management 'none'",
  "xr-spatial-tracking 'none'",
].join("; ");

export const TEMPLATE_PREVIEW_MAX_HTML_CHARS = 500_000;
export const TEMPLATE_PREVIEW_MAX_ELEMENTS = 3_000;
export const TEMPLATE_PREVIEW_MAX_CSS_CHARS = 100_000;

const PREVIEW_LIMIT_MESSAGE =
  "This template is too complex for the safe desktop preview. Review and simplify its source before sending.";

const BLOCKED_ELEMENTS = [
  "animate",
  "animatemotion",
  "animatetransform",
  "applet",
  "base",
  "embed",
  "fencedframe",
  "frame",
  "frameset",
  "iframe",
  "link",
  "meta",
  "noscript",
  "object",
  "portal",
  "script",
  "set",
  "webview",
].join(",");

const ENDPOINT_ATTRIBUTES = new Set([
  "action",
  "archive",
  "attributionsrc",
  "background",
  "cite",
  "classid",
  "code",
  "codebase",
  "data",
  "dynsrc",
  "formaction",
  "href",
  "icon",
  "imagesrcset",
  "longdesc",
  "lowsrc",
  "manifest",
  "ping",
  "poster",
  "profile",
  "src",
  "srcset",
  "usemap",
]);

const DISABLED_FORM_ELEMENTS = new Set([
  "button",
  "fieldset",
  "input",
  "select",
  "textarea",
]);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("`", "&#96;")
    .replaceAll("=", "&#61;")
    .replace(/[\t\n\f\r ]/g, (character) => `&#${character.charCodeAt(0)};`);
}

function isSafeEmbeddedImage(value: string): boolean {
  const normalized = value.trim();
  if (/^blob:/i.test(normalized)) return true;
  return /^data:image\/(?:avif|gif|jpe?g|png|svg\+xml|webp)(?:[;,])/i.test(
    normalized,
  );
}

function isSafeEmbeddedStyleResource(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.startsWith("#") ||
    /^blob:/i.test(normalized) ||
    /^data:(?:font|image)\//i.test(normalized)
  );
}

function hardenInlineCss(css: string): string {
  return css
    .slice(0, TEMPLATE_PREVIEW_MAX_CSS_CHARS)
    .replace(
      /@import\s+(?:url\(\s*)?(?:"[^"]*"|'[^']*'|[^;)\s]+)\s*\)?[^;]*;?/gi,
      "",
    )
    .replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
      (match, doubleQuoted: string, singleQuoted: string, bare: string) => {
        const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
        return isSafeEmbeddedStyleResource(value) ? match : "none";
      },
    );
}

function hardenFragment(root: ParentNode): void {
  root
    .querySelectorAll(BLOCKED_ELEMENTS)
    .forEach((element) => element.remove());

  root.querySelectorAll("*").forEach((element) => {
    const tagName = element.localName.toLowerCase();
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const isEmbeddedImage =
        tagName === "img" &&
        name === "src" &&
        isSafeEmbeddedImage(attribute.value);
      if (
        /^on/i.test(name) ||
        name.endsWith(":href") ||
        (ENDPOINT_ATTRIBUTES.has(name) && !isEmbeddedImage) ||
        name === "autofocus" ||
        name === "accesskey" ||
        name === "contenteditable" ||
        name === "download" ||
        name === "draggable" ||
        name === "tabindex" ||
        name === "target"
      ) {
        element.removeAttribute(attribute.name);
      }
    });

    if (tagName === "a" || tagName === "area") {
      element.setAttribute("role", "link");
      element.setAttribute("aria-disabled", "true");
      element.setAttribute("tabindex", "-1");
    }
    if (tagName === "form") {
      element.setAttribute("aria-disabled", "true");
    }
    if (DISABLED_FORM_ELEMENTS.has(tagName)) {
      element.setAttribute("disabled", "");
    }
    if (tagName === "audio" || tagName === "video") {
      element.removeAttribute("autoplay");
    }
    if (tagName === "style") {
      element.textContent = hardenInlineCss(element.textContent ?? "");
    }
    if (element.hasAttribute("style")) {
      element.setAttribute(
        "style",
        hardenInlineCss(element.getAttribute("style") ?? ""),
      );
    }

    // Declarative shadow roots are parsed from nested template contents.
    // Walk those fragments explicitly and prevent shadow attachment so no
    // endpoint can hide outside the ordinary descendant traversal.
    if (tagName === "template") {
      element.removeAttribute("shadowrootmode");
      element.removeAttribute("shadowrootdelegatesfocus");
      hardenFragment((element as HTMLTemplateElement).content);
    }
  });
}

/**
 * Parse into an inert template so resource attributes cannot fetch while we
 * remove them. CSP remains the enforcement boundary; this pass also keeps
 * links and controls visibly representative without making them actionable.
 */
function hardenTemplatePreviewBody(html: string): string {
  if (!html) return "";
  if (html.length > TEMPLATE_PREVIEW_MAX_HTML_CHARS) {
    return `<p data-pw-preview-limit="html">${escapeHtml(PREVIEW_LIMIT_MESSAGE)}</p>`;
  }
  if (typeof document === "undefined") return escapeHtml(html);
  const template = document.createElement("template");
  template.innerHTML = html;
  if (
    template.content.querySelectorAll("*").length >
    TEMPLATE_PREVIEW_MAX_ELEMENTS
  ) {
    return `<p data-pw-preview-limit="elements">${escapeHtml(PREVIEW_LIMIT_MESSAGE)}</p>`;
  }
  hardenFragment(template.content);
  return template.innerHTML;
}

/**
 * Resolve {{var}} placeholders. Unrecognised variables are left
 * as-is so the operator can see which ones still need values.
 */
function interpolate(
  html: string,
  vars: Record<string, string> | undefined,
): string {
  if (!vars || !html) return html;
  return html.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return `{{${name}}}`;
    const value = vars[name];
    return value != null ? escapeHtml(String(value)) : `{{${name}}}`;
  });
}

function buildSrcDoc(opts: {
  body: string;
  dark: boolean;
  device: PreviewDevice;
}): string {
  const { body, dark, device } = opts;
  const bg = dark ? "#0b1220" : "#ffffff";
  const fg = dark ? "#e2e8f0" : "#111827";
  const muted = dark ? "#94a3b8" : "#6b7280";
  const width = DEVICE_WIDTH[device];
  // The reset is intentionally light — we don't want to override
  // operator styling. We only ensure backgrounds + sane defaults
  // so an untyped body doesn't look broken.
  return `<!doctype html>
<html lang="en">
<head>
  <meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}" />
  <meta name="referrer" content="no-referrer" />
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html, body { margin: 0; padding: 0; background: ${bg}; color: ${fg};
                 font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                              Roboto, Helvetica, Arial, sans-serif; }
    body { padding: 16px 0; }
    /* Constrain operator email markup to the device frame so a fixed
       600-wide table doesn't blow out on mobile. */
    body > * { max-width: ${width}px; margin-left: auto; margin-right: auto; }
    a { color: ${dark ? "#7dd3fc" : "#0d9488"}; }
    img { max-width: 100%; height: auto; }
    /* Subtle helper for any unfilled merge-tags so they don't
       silently look like body copy. */
    .pw-unset-var { background: ${dark ? "#1e293b" : "#fef3c7"};
                    color: ${muted}; padding: 0 2px; border-radius: 2px; }
    a[aria-disabled="true"] { cursor: not-allowed; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 0.01ms !important;
                               animation-iteration-count: 1 !important;
                               scroll-behavior: auto !important;
                               transition-duration: 0.01ms !important; }
    }
  </style>
</head>
<body>${body}</body>
</html>`;
}

/**
 * The component itself. Re-renders the iframe srcDoc whenever the
 * inputs change. We avoid React DOM into the iframe — srcDoc gives
 * us a single-shot blob the browser parses, no contentDocument
 * mutation needed.
 */
export function TemplatePreview({
  html,
  mjml,
  device = "desktop",
  dark = false,
  variables,
  height = 480,
}: TemplatePreviewProps): ReactElement {
  const safetyDescriptionId = useId();
  const srcDoc = useMemo(() => {
    if (!html) return "";
    const interpolated = interpolate(html, variables);
    const safe = hardenTemplatePreviewBody(interpolated);
    return buildSrcDoc({ body: safe, dark, device });
  }, [html, variables, dark, device]);

  // Empty-body branch: prefer surfacing the MJML hint over a blank
  // canvas (matches the existing slideover behaviour where MJML
  // source can be present without compiled HTML).
  if (!html) {
    return (
      <div
        className="tpl-preview-empty"
        style={{
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          fontSize: 12,
          textAlign: "center",
          color: "var(--pw-fg-muted)",
          background: dark
            ? "var(--pw-bg)"
            : "color-mix(in srgb, var(--pw-fg) 4%, transparent)",
          border: "1px solid var(--pw-border)",
          borderRadius: 6,
        }}
      >
        {mjml ? (
          <span>
            This template ships MJML source only — open in the campaign editor
            to compile it to HTML for preview.
          </span>
        ) : (
          <span>No body content to preview yet.</span>
        )}
      </div>
    );
  }

  return (
    <div
      className={`tpl-preview-frame${dark ? " tpl-preview-dark" : ""}`}
      style={{
        height,
        background: dark
          ? "var(--pw-bg)"
          : "color-mix(in srgb, var(--pw-fg) 4%, transparent)",
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <p
        id={safetyDescriptionId}
        style={{
          margin: 0,
          padding: "7px 10px",
          color: "var(--pw-fg-muted)",
          background: "var(--pw-bg-elev)",
          borderBottom: "1px solid var(--pw-border)",
          fontSize: 12,
          lineHeight: 1.4,
        }}
      >
        Safety preview: external assets, links, forms, and tracking requests are
        blocked. Embedded data images remain visible. Over-complex documents are
        replaced with a safety notice.
      </p>
      <div
        style={{
          minHeight: 0,
          flex: 1,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <iframe
          title="Template preview"
          aria-describedby={safetyDescriptionId}
          // Empty sandbox: unique origin, no scripts, forms, downloads,
          // popups, storage, modals, or navigation capabilities.
          sandbox=""
          allow={PREVIEW_PERMISSIONS}
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          style={{
            width: DEVICE_WIDTH[device],
            maxWidth: "100%",
            height: "100%",
            border: 0,
            background: "transparent",
          }}
        />
      </div>
    </div>
  );
}

/**
 * PreviewToolbar — small chrome above the iframe for the
 * device + dark toggles + an optional "Preview as" row.
 *
 * Pulled out as its own component so callers (Templates list card,
 * slideover, future inbox-rendering preview) can place it next to
 * the iframe without duplicating layout.
 */
export function TemplatePreviewToolbar({
  device,
  onDeviceChange,
  dark,
  onDarkChange,
  extraRight,
}: {
  device: PreviewDevice;
  onDeviceChange: (d: PreviewDevice) => void;
  dark: boolean;
  onDarkChange: (b: boolean) => void;
  extraRight?: ReactElement;
}): ReactElement {
  return (
    <div
      className="tpl-preview-toolbar row"
      style={{ gap: 6, marginBottom: 8, alignItems: "center" }}
    >
      <ChoiceGroup
        legend="Device preview"
        value={device}
        onChange={onDeviceChange}
        className="chips"
        optionClassName="chip"
        options={(["desktop", "mobile"] as PreviewDevice[]).map((value) => ({
          value,
          label: value === "desktop" ? "Desktop" : "Mobile",
          className: device === value ? "is-active" : undefined,
        }))}
      />
      <button
        type="button"
        className={`chip${dark ? " is-active" : ""}`}
        onClick={() => onDarkChange(!dark)}
        aria-pressed={dark}
        aria-label={`Use ${dark ? "light" : "dark"} preview rendering`}
      >
        {dark ? "Dark" : "Light"}
      </button>
      <span className="spacer" />
      {extraRight}
    </div>
  );
}
