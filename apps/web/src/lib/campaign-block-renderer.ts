import sanitizeHtml from "sanitize-html";

import { sanitizeArchiveHTML } from "@/lib/sanitize-html";

export type CampaignEmailBlock = Record<string, unknown>;

const MAX_RENDER_BLOCKS = 100;
const MAX_BLOCK_TEXT_CHARS = 10_000;
const MAX_EMAIL_URL_CHARS = 2_048;

export function renderCampaignBlocksToHTML(
  blocks: CampaignEmailBlock[],
): string {
  const html = blocks
    .slice(0, MAX_RENDER_BLOCKS)
    .map((block) => {
      const type = asString(block.type, "text");
      if (type === "heading") {
        return `<h2>${escapeHTML(asString(block.content, "New headline"))}</h2>`;
      }
      if (type === "image") {
        const url = escapeAttr(
          safeEmailAssetURL(asString(block.url, asString(block.image_url))),
        );
        const alt = escapeAttr(asString(block.alt_text));
        return url
          ? `<p><img src="${url}" alt="${alt}" style="max-width:100%;height:auto;" /></p>`
          : "";
      }
      if (type === "button") {
        const url = escapeAttr(
          safeEmailLinkURL(asString(block.url)),
        );
        const label = escapeHTML(asString(block.label, "Read more"));
        return url
          ? `<p><a href="${url}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:6px;">${label}</a></p>`
          : `<p>${label}</p>`;
      }
      if (type === "product") {
        const title = escapeHTML(
          asString(block.title, asString(block.name, "Featured product")),
        );
        const titleAttr = escapeAttr(
          asString(block.title, asString(block.name, "Featured product")),
        );
        const url = escapeAttr(
          safeEmailLinkURL(asString(block.url)),
        );
        const image = escapeAttr(safeEmailAssetURL(asString(block.image_url)));
        const price = escapeHTML(asString(block.price));
        const cta = url ? `<p><a href="${url}">View product</a></p>` : "";
        return `<section><h3>${title}</h3>${image ? `<img src="${image}" alt="${titleAttr}" style="max-width:100%;height:auto;" />` : ""}${price ? `<p>${price}</p>` : ""}${cta}</section>`;
      }
      if (type === "product_recommendations") {
        const title = escapeHTML(asString(block.title, "Recommended for you"));
        const products = [1, 2, 3]
          .map((idx) => {
            const name = escapeHTML(
              asString(block[`product_${idx}_title`], `Product ${idx}`),
            );
            const image = escapeAttr(
              safeEmailAssetURL(asString(block[`product_${idx}_image`])),
            );
            const url = escapeAttr(
              safeEmailLinkURL(asString(block[`product_${idx}_url`])),
            );
            return `<article style="display:inline-block;vertical-align:top;width:31%;min-width:160px;margin-right:2%;"><h3>${name}</h3>${image ? `<img src="${image}" alt="${escapeAttr(name)}" style="max-width:100%;height:auto;" />` : ""}${url ? `<p><a href="${url}">${escapeHTML(asString(block.button_label, "Shop now"))}</a></p>` : ""}</article>`;
          })
          .join("");
        return `<section><h2>${title}</h2>${products}</section>`;
      }
      if (type === "discount_code") {
        const code = escapeHTML(asString(block.code, "SAVE10"));
        const desc = escapeHTML(
          asString(block.description, "Use this code at checkout."),
        );
        const url = escapeAttr(
          safeEmailLinkURL(asString(block.url)),
        );
        const label = escapeHTML(asString(block.label, "Redeem offer"));
        return `<section><p>${desc}</p><p style="font-size:24px;font-weight:700;letter-spacing:2px;">${code}</p>${url ? `<p><a href="${url}">${label}</a></p>` : ""}</section>`;
      }
      if (type === "survey") {
        const question = escapeHTML(
          asString(block.question, "What did you think?"),
        );
        const choices = asStringArray(block.choices, [
          "Great",
          "Okay",
          "Not for me",
        ]);
        const surveyURL = safeEmailLinkURL(
          asString(block.url),
        );
        const links = choices
          .map((choice) => {
            const label = escapeHTML(choice);
            const url = surveyURL
              ? `${surveyURL}${surveyURL.includes("?") ? "&" : "?"}answer=${encodeURIComponent(choice)}`
              : "";
            return url ? `<a href="${escapeAttr(url)}">${label}</a>` : label;
          })
          .join(" | ");
        return `<section><h3>${question}</h3><p>${links}</p></section>`;
      }
      if (type === "social_follow") {
        return `<p>${[
          ["Facebook", block.facebook_url],
          ["Instagram", block.instagram_url],
          ["LinkedIn", block.linkedin_url],
          ["X", block.x_url],
        ]
          .map(([label, raw]) => {
            const url = escapeAttr(safeEmailLinkURL(asString(raw)));
            return url ? `<a href="${url}">${label}</a>` : "";
          })
          .filter(Boolean)
          .join(" &nbsp; ")}</p>`;
      }
      if (type === "social_share") {
        const shareURL = safeEmailLinkURL(asString(block.share_url));
        const text = escapeHTML(asString(block.text, "Share this"));
        if (!shareURL) return `<p>${text}</p>`;
        const encodedShareURL = escapeAttr(encodeURIComponent(shareURL));
        return `<p>${text}: <a href="https://www.facebook.com/sharer/sharer.php?u=${encodedShareURL}">Facebook</a> | <a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodedShareURL}">LinkedIn</a> | <a href="https://twitter.com/intent/tweet?url=${encodedShareURL}">X</a></p>`;
      }
      if (type === "rss") {
        const feed = escapeAttr(
          safeEmailLinkURL(asString(block.feed_url)),
        );
        const title = escapeHTML(asString(block.title, "Latest posts"));
        return `<section><h3>${title}</h3>${feed ? `<p><a href="${feed}">Read the latest posts</a></p>` : ""}</section>`;
      }
      if (type === "video") {
        const videoURL = escapeAttr(
          safeEmailLinkURL(
            asString(block.video_url, asString(block.url)),
          ),
        );
        const thumb = escapeAttr(
          safeEmailAssetURL(
            asString(block.thumbnail_url, asString(block.image_url)),
          ),
        );
        const title = escapeHTML(asString(block.title, "Watch video"));
        const image = thumb
          ? videoURL
            ? `<a href="${videoURL}"><img src="${thumb}" alt="${escapeAttr(title)}" style="max-width:100%;height:auto;" /></a>`
            : `<img src="${thumb}" alt="${escapeAttr(title)}" style="max-width:100%;height:auto;" />`
          : "";
        const titleMarkup = videoURL ? `<a href="${videoURL}">${title}</a>` : title;
        return `<section>${image}<p>${titleMarkup}</p></section>`;
      }
      if (type === "dynamic_content") {
        // The send engine has no evaluator for editor-only conditions. Render
        // the explicit fallback instead of leaking Handlebars source to inboxes.
        return `<p>${escapeHTML(asString(block.fallback, asString(block.content, "General offer")))}</p>`;
      }
      if (type === "conditional_content") {
        return `<p>${escapeHTML(asString(block.fallback, asString(block.content, "Hello")))}</p>`;
      }
      if (type === "section") {
        return sanitizeArchiveHTML(asString(block.content));
      }
      return `<p>${escapeHTML(asString(block.content, asString(block.body, ""))).replace(/\n/g, "<br />")}</p>`;
    })
    .filter(Boolean)
    .join("\n");
  return `${html}\n<p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>`;
}

export function renderCampaignBlocksToText(
  blocks: CampaignEmailBlock[],
): string {
  return blocks
    .slice(0, MAX_RENDER_BLOCKS)
    .map((block) =>
      [
        asString(block.content),
        asString(block.heading),
        asString(block.title),
        asString(block.label),
        safeEmailLinkURL(asString(block.url)),
      ]
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean)
    .join("\n\n");
}

export function safeEmailLinkURL(value: string): string {
  const safe = safeEmailURL(value, ["http:", "https:", "mailto:"]);
  return isExamplePlaceholderURL(safe) ? "" : safe;
}

export function safeEmailAssetURL(value: string): string {
  const safe = safeEmailURL(value, ["http:", "https:"]);
  return isExamplePlaceholderURL(safe) ? "" : safe;
}

type CampaignURLKind = "link" | "asset";

interface CampaignURLField {
  label: string;
  value: unknown;
  kind: CampaignURLKind;
}

const SUPPORTED_LINK_TOKEN =
  /^\{\{\s*(?:unsubscribe_url|Unsubscribe\.URL|UnsubscribeURL)\s*\}\}$/;

/**
 * Validate URL-bearing block source before it is persisted. Rendering omits an
 * unsafe URL, but the source block is stored alongside the projection; without
 * this check a later renderer could revive that dormant value.
 */
export function campaignBlockLinkError(
  blocks: readonly CampaignEmailBlock[],
): string | null {
  for (const [index, block] of blocks.slice(0, MAX_RENDER_BLOCKS).entries()) {
    const type = asString(block.type, "text");
    for (const field of blockURLFields(block, type)) {
      const error = campaignURLFieldError(field.value, field.kind);
      if (error) return `Block ${index + 1} ${field.label} ${error}`;
    }
    if (type === "section") {
      const error = campaignHTMLLinkError(
        asString(block.content),
        `Block ${index + 1} section HTML`,
      );
      if (error) return error;
    }
  }
  return null;
}

/** Parser-backed inspection for raw HTML/MJML authoring modes and variants. */
export function campaignHTMLLinkError(
  html: string,
  location = "Campaign HTML",
): string | null {
  if (!html.trim()) return null;
  let error: string | null = null;
  const inspect = (
    tagName: string,
    attribs: Record<string, string>,
  ): sanitizeHtml.Tag => {
    if (!error) {
      for (const field of htmlURLFields(tagName, attribs)) {
        const fieldError = campaignURLFieldError(field.value, field.kind);
        if (fieldError) {
          error = `${location} ${field.label} ${fieldError}`;
          break;
        }
      }
    }
    return { tagName, attribs };
  };

  try {
    sanitizeHtml(html, {
      allowedTags: [
        "a",
        "area",
        "blockquote",
        "img",
        "link",
        "q",
        "source",
        "mj-button",
        "mj-image",
        "mj-social-element",
      ],
      allowedAttributes: {
        a: ["href"],
        area: ["href"],
        blockquote: ["cite"],
        img: ["src", "srcset"],
        link: ["href"],
        q: ["cite"],
        source: ["src", "srcset"],
        "mj-button": ["href"],
        "mj-image": ["href", "src", "srcset"],
        "mj-social-element": ["href", "src"],
      },
      allowProtocolRelative: false,
      transformTags: {
        a: inspect,
        area: inspect,
        blockquote: inspect,
        img: inspect,
        link: inspect,
        q: inspect,
        source: inspect,
        "mj-button": inspect,
        "mj-image": inspect,
        "mj-social-element": inspect,
      },
    });
  } catch {
    return `${location} could not be parsed safely. Nothing was saved or sent.`;
  }
  return error;
}

export function campaignPlainTextLinkError(
  text: string,
  location = "Campaign plain text",
): string | null {
  return /https?:\/\/(?:www\.)?example\.com(?=$|[/?#:\s"'<>])/i.test(text)
    ? `${location} contains an example.com placeholder. Replace or remove it before saving or sending.`
    : null;
}

/** Validate URL fields in the semantic AST without accepting placeholder data. */
export function campaignSemanticLinkError(
  nodes: readonly Record<string, unknown>[],
): string | null {
  const seen = new WeakSet<object>();
  let visited = 0;

  const visit = (value: unknown, path: string, depth: number): string | null => {
    if (depth > 32 || visited > 20_000) {
      return "Semantic campaign source is too complex to validate safely. Nothing was saved or sent.";
    }
    if (value === null || typeof value !== "object") return null;
    if (seen.has(value)) {
      return "Semantic campaign source contains a cyclic value. Nothing was saved or sent.";
    }
    seen.add(value);
    visited += 1;
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const error = visit(item, `${path}/${index}`, depth + 1);
        if (error) return error;
      }
      return null;
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}/${key}`;
      if (
        typeof child === "string" &&
        (key === "url" ||
          key === "href" ||
          key === "canonical_url" ||
          key === "image_url")
      ) {
        const error = campaignURLFieldError(
          child,
          key === "image_url" ? "asset" : "link",
        );
        if (error) return `Semantic source ${childPath} ${error}`;
      }
      const error = visit(child, childPath, depth + 1);
      if (error) return error;
    }
    return null;
  };

  return visit(nodes, "/nodes", 0);
}

function blockURLFields(
  block: CampaignEmailBlock,
  type: string,
): CampaignURLField[] {
  switch (type) {
    case "image":
      return [
        { label: "image URL", value: block.url, kind: "asset" },
        { label: "image URL", value: block.image_url, kind: "asset" },
      ];
    case "button":
      return [{ label: "button URL", value: block.url, kind: "link" }];
    case "product":
      return [
        { label: "product URL", value: block.url, kind: "link" },
        { label: "image URL", value: block.image_url, kind: "asset" },
      ];
    case "product_recommendations":
      return [1, 2, 3].flatMap((idx) => [
        {
          label: `product ${idx} URL`,
          value: block[`product_${idx}_url`],
          kind: "link" as const,
        },
        {
          label: `product ${idx} image URL`,
          value: block[`product_${idx}_image`],
          kind: "asset" as const,
        },
      ]);
    case "discount_code":
      return [{ label: "offer URL", value: block.url, kind: "link" }];
    case "survey":
      return [{ label: "survey URL", value: block.url, kind: "link" }];
    case "social_follow":
      return ["facebook", "instagram", "linkedin", "x"].map((network) => ({
        label: `${network} URL`,
        value: block[`${network}_url`],
        kind: "link" as const,
      }));
    case "social_share":
      return [{ label: "share URL", value: block.share_url, kind: "link" }];
    case "rss":
      return [{ label: "feed URL", value: block.feed_url, kind: "link" }];
    case "video":
      return [
        { label: "video URL", value: block.video_url, kind: "link" },
        { label: "video URL", value: block.url, kind: "link" },
        {
          label: "thumbnail URL",
          value: block.thumbnail_url,
          kind: "asset",
        },
        { label: "thumbnail URL", value: block.image_url, kind: "asset" },
      ];
    default:
      return [];
  }
}

function htmlURLFields(
  tagName: string,
  attributes: Record<string, string>,
): CampaignURLField[] {
  const fields: CampaignURLField[] = [];
  const tag = tagName.toLowerCase();
  const linkAttributes =
    tag === "img" || tag === "source"
      ? []
      : tag === "mj-image"
        ? ["href"]
        : [tag === "blockquote" || tag === "q" ? "cite" : "href"];
  const assetAttributes =
    tag === "img" || tag === "source" || tag === "mj-image"
      ? ["src"]
      : tag === "mj-social-element"
        ? ["src"]
        : [];
  for (const name of linkAttributes) {
    fields.push({
      label: `<${tag}> ${name}`,
      value: attributes[name],
      kind: "link",
    });
  }
  for (const name of assetAttributes) {
    fields.push({
      label: `<${tag}> ${name}`,
      value: attributes[name],
      kind: "asset",
    });
  }
  if ((tag === "img" || tag === "source" || tag === "mj-image") && attributes.srcset) {
    for (const candidate of attributes.srcset.split(",")) {
      fields.push({
        label: `<${tag}> srcset`,
        value: candidate.trim().split(/\s+/, 1)[0],
        kind: "asset",
      });
    }
  }
  return fields;
}

function campaignURLFieldError(
  value: unknown,
  kind: CampaignURLKind,
): string | null {
  const raw = asString(value).trim();
  if (!raw) return null;
  if (kind === "link" && SUPPORTED_LINK_TOKEN.test(raw)) return null;
  if (isExamplePlaceholderURL(raw)) {
    return "still points to example.com. Replace or remove the placeholder before saving or sending.";
  }
  const safe = kind === "link" ? safeEmailLinkURL(raw) : safeEmailAssetURL(raw);
  if (safe) return null;
  return kind === "link"
    ? "must be a safe absolute HTTP, HTTPS, or mailto URL. Nothing was saved or sent."
    : "must be a safe absolute HTTP or HTTPS URL. Nothing was saved or sent.";
}

function isExamplePlaceholderURL(value: string): boolean {
  if (!value.trim()) return false;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (hostname === "example.com" || hostname === "www.example.com")
    );
  } catch {
    return false;
  }
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.slice(0, MAX_BLOCK_TEXT_CHARS);
  if (value === null || value === undefined) {
    return fallback.slice(0, MAX_BLOCK_TEXT_CHARS);
  }
  return String(value).slice(0, MAX_BLOCK_TEXT_CHARS);
}

function asStringArray(value: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => asString(item).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return fallback;
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[char] ?? char;
  });
}

function escapeAttr(value: string): string {
  return escapeHTML(value).replace(/`/g, "&#96;");
}

function safeEmailURL(value: string, allowedProtocols: string[]): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    trimmed.length > MAX_EMAIL_URL_CHARS ||
    /[\u0000-\u001F\u007F]/.test(trimmed)
  ) {
    return "";
  }
  try {
    const url = new URL(trimmed);
    if (url.username || url.password) return "";
    if (!allowedProtocols.includes(url.protocol)) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}
