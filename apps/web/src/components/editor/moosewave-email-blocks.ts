// SPDX-License-Identifier: AGPL-3.0-only

// Email clients do not share the dashboard's local font assets. Keep the
// palette's Moosewave color/typographic hierarchy with email-safe fallbacks.
import type { WorkspaceSettings } from "@/lib/workspace-settings-api";

export const DEFAULT_MJML = `<mjml>
  <mj-head>
    <mj-attributes><mj-all font-family="Arial, Helvetica, sans-serif"></mj-all></mj-attributes>
  </mj-head>
  <mj-body background-color="#fdfcf8">
    <mj-section background-color="#ffdf38" padding="18px 28px">
      <mj-column>
        <mj-text font-size="22px" font-weight="800" color="#0f0f0f" letter-spacing="-1px">
          MOOSEWAVE
        </mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="#ffffff" padding="36px 28px">
      <mj-column>
        <mj-text font-size="32px" font-weight="800" line-height="1.1" color="#0f0f0f">
          Your headline goes here.
        </mj-text>
        <mj-text font-size="16px" line-height="1.6" color="#30302e">
          Write a message worth opening. Use the blocks on the left to build your story.
        </mj-text>
        <mj-button background-color="#ffdf38" color="#0f0f0f" font-weight="700" border-radius="4px" href="https://example.com">Take a look</mj-button>
      </mj-column>
    </mj-section>
    <mj-section padding="20px 28px">
      <mj-column>
        <mj-text align="center" font-size="12px" color="#575750">
          You received this because you subscribed.
          <a href="{{ unsubscribe_url }}" style="color:#30302e;">Unsubscribe</a>.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

export function initialBlockMjml(mjml?: string): string {
  const source = mjml?.trim() ? mjml : DEFAULT_MJML;
  // grapesjs-mjml uses an HTML parser for the canvas. It treats `<mj-image />`
  // and other self-closing MJML elements as open tags, which can silently
  // nest later blocks beneath them when the author saves. Explicit close tags
  // preserve sibling blocks and compile to the same email HTML.
  return source.replace(
    /<(mj-[a-z0-9-]+)\b([^<>]*?)\s*\/>/gi,
    (_match, tag: string, attributes: string) => `<${tag}${attributes}></${tag}>`,
  );
}

export interface WorkspaceMJMLBlock {
  id: string;
  name: string;
  source: string;
}

function escapeMjml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function brandInk(background: string): string {
  const channels = [1, 3, 5].map((index) => parseInt(background.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  return luminance > 0.179 ? "#111111" : "#ffffff";
}

/** Brand-kit fragments are inserted as copies; subsequent settings edits do not silently rewrite drafts. */
export function workspaceBrandBlocks(settings: WorkspaceSettings): WorkspaceMJMLBlock[] {
  const color = /^#[0-9a-fA-F]{6}$/.test(settings.brand_color ?? "")
    ? settings.brand_color!.toLowerCase()
    : "#ffdf38";
  const ink = brandInk(color);
  const rawName = settings.display_name?.trim() || "Your workspace";
  const name = escapeMjml(rawName);
  let logo = "";
  try {
    const parsed = new URL(settings.logo_url ?? "");
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) {
      logo = `<mj-image src="${escapeMjml(parsed.toString())}" alt="${escapeMjml(rawName)} logo" width="160px" align="left" padding="0" />`;
    }
  } catch { /* No usable workspace logo. */ }
  return [
    {
      id: "brand-header",
      name: "Workspace brand header",
      source: `<mj-section background-color="${color}" padding="20px 28px"><mj-column>${logo || `<mj-text color="${ink}" font-size="22px" font-weight="800" padding="0">${name}</mj-text>`}</mj-column></mj-section>`,
    },
    {
      id: "brand-cta",
      name: "Workspace brand button",
      source: `<mj-section padding="12px 28px"><mj-column><mj-button background-color="${color}" color="${ink}" font-size="16px" font-weight="700" href="https://example.com">Your call to action</mj-button></mj-column></mj-section>`,
    },
  ];
}

export const BRANDED_BLOCKS = [
  {
    id: "mw-headline",
    label: "Moosewave headline",
    content:
      '<mj-section background-color="#ffffff" padding="36px 28px"><mj-column><mj-text font-size="32px" font-weight="800" line-height="1.1" color="#0f0f0f">Make the main idea unmistakable.</mj-text><mj-text font-size="16px" line-height="1.6" color="#30302e">Add the supporting detail here.</mj-text></mj-column></mj-section>',
  },
  {
    id: "mw-cta",
    label: "Yellow call to action",
    content:
      '<mj-section background-color="#ffffff" padding="12px 28px 32px"><mj-column><mj-button background-color="#ffdf38" color="#0f0f0f" font-size="16px" font-weight="700" border-radius="4px" href="https://example.com">Explore now</mj-button></mj-column></mj-section>',
  },
  {
    id: "mw-callout",
    label: "Highlighted note",
    content:
      '<mj-section background-color="#ffdf38" padding="24px 28px"><mj-column><mj-text font-size="19px" font-weight="700" color="#0f0f0f">The important bit.</mj-text><mj-text font-size="15px" line-height="1.5" color="#0f0f0f">Give this idea room to breathe.</mj-text></mj-column></mj-section>',
  },
  {
    id: "mw-footer",
    label: "Accessible footer",
    content:
      '<mj-section background-color="#fdfcf8" padding="20px 28px"><mj-column><mj-text align="center" font-size="12px" color="#575750">You received this because you subscribed. <a href="{{ unsubscribe_url }}" style="color:#30302e;">Unsubscribe</a>.</mj-text></mj-column></mj-section>',
  },
] as const;
