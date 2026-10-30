#!/usr/bin/env python3
"""Turn one item-specific brief into an editable MJML starting scaffold.

This builder handles email-safe structure but repeats a small set of layouts.
Its output needs a reference-specific composition, type, color, image, and
mobile review before it counts as an enhanced design. It does not infer claims
from source material and refuses to overwrite a hand-edited template unless
--force is supplied.
"""

from __future__ import annotations

import argparse
import json
from html import escape
from pathlib import Path


def text(value: str) -> str:
    return escape(value, quote=False)


def attr(value: str) -> str:
    return escape(value, quote=True)


def section(body: str, background: str, padding: str) -> str:
    return (
        f'    <mj-section background-color="{attr(background)}" padding="{padding}">\n'
        f"      <mj-column>\n{body}\n      </mj-column>\n"
        "    </mj-section>"
    )


def line(content: str, **attrs: str) -> str:
    attributes = " ".join(f'{key.replace("_", "-")}="{attr(value)}"' for key, value in attrs.items())
    return f"        <mj-text {attributes}>{text(content)}</mj-text>"


def build(config: dict) -> str:
    required = (
        "catalog_id", "subject", "preview_text", "hero_alt", "hero_prompt",
        "title", "intro", "kicker", "cta_label", "palette", "sections", "layout",
    )
    missing = [key for key in required if not config.get(key)]
    if missing:
        raise ValueError(f"Missing draft fields: {', '.join(missing)}")
    palette = config["palette"]
    for key in ("background", "surface", "ink", "accent", "band", "muted"):
        if not isinstance(palette.get(key), str) or not palette[key].startswith("#"):
            raise ValueError(f"Missing color: {key}")
    if config["layout"] not in {"story", "digest", "roundup", "celebration"}:
        raise ValueError("Unknown email layout")
    if not isinstance(config["sections"], list) or len(config["sections"]) < 2:
        raise ValueError("At least two individually editable content sections are required")

    brand = section(
        line("{{ brand_name }}", padding="0", font_size="17px", font_weight="bold"),
        palette["surface"], "24px 30px 16px",
    )
    heading = section(
        "\n".join([
            line(config["kicker"].upper(), padding="0", font_size="11px", font_weight="bold", letter_spacing="2px", color=palette["accent"]),
            line(config["title"], padding="10px 0 0", font_size="36px", font_weight="bold", line_height="1.16", color=palette["ink"]),
            line(config["intro"], padding="13px 0 0", color=palette["ink"]),
        ]),
        palette["band"] if config["layout"] in {"digest", "celebration"} else palette["surface"],
        "22px 30px 29px",
    )
    hero = section(
        f'        <mj-image src="__HERO_IMAGE_URL__" alt="{attr(config["hero_alt"])}" fluid-on-mobile="true" padding="0"></mj-image>',
        palette["surface"], "0 30px",
    )
    blocks = [brand]
    if config["layout"] == "celebration":
        blocks.extend([hero, heading])
    else:
        blocks.extend([heading, hero])

    for index, item in enumerate(config["sections"]):
        if not item.get("heading") or not item.get("body"):
            raise ValueError(f"Incomplete content section {index + 1}")
        background = palette["band"] if item.get("emphasis") else palette["surface"]
        content = []
        if config["layout"] == "roundup" and index:
            content.append(f'        <mj-divider border-width="1px" border-color="{attr(palette["muted"])}" padding="0 0 17px"></mj-divider>')
        if config["layout"] in {"digest", "roundup"}:
            content.append(line(f"{index + 1:02d} / {item['heading']}", padding="0", font_size="17px", font_weight="bold", color=palette["ink"]))
        else:
            content.append(line(item["heading"], padding="0", font_size="20px", font_weight="bold", color=palette["ink"]))
        content.append(line(item["body"], padding="9px 0 0", color=palette["ink"]))
        blocks.append(section("\n".join(content), background, "22px 30px 19px"))

    blocks.append(section(
        f'        <mj-button href="__CTA_URL__" align="left" padding="0">{text(config["cta_label"])}</mj-button>',
        palette["surface"], "18px 30px 36px",
    ))
    footer = "\n".join([
        line("{{ brand_name }} · Add your mailing address before sending", padding="0 0 7px", font_size="12px", color=palette["muted"], align="center"),
        f'        <mj-text padding="0" font-size="12px" align="center"><a href="{{{{unsubscribe_url}}}}" style="color:{attr(palette["accent"])};text-decoration:underline">Unsubscribe</a></mj-text>',
    ])
    blocks.append(section(footer, palette["background"], "23px 30px 30px"))
    return (
        "<mjml>\n  <mj-head>\n"
        f'    <mj-title>{text(config["subject"])}</mj-title>\n'
        f'    <mj-preview>{text(config["preview_text"])}</mj-preview>\n'
        "    <mj-attributes>\n"
        '      <mj-all font-family="Arial, Helvetica, sans-serif"></mj-all>\n'
        f'      <mj-text color="{attr(palette["ink"])}" font-size="15px" line-height="1.6"></mj-text>\n'
        f'      <mj-button background-color="{attr(palette["accent"])}" color="#ffffff" border-radius="4px" font-size="14px" font-weight="bold" inner-padding="14px 25px"></mj-button>\n'
        "    </mj-attributes>\n  </mj-head>\n"
        f'  <mj-body width="600px" background-color="{attr(palette["background"])}">\n'
        + "\n".join(blocks) + "\n"
        "  </mj-body>\n</mjml>\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("item_dir", type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    directory = args.item_dir.resolve()
    config = json.loads((directory / "draft.json").read_text())
    if not (directory / "hero.png").is_file():
        raise FileNotFoundError("Generate and inspect an original hero before building MJML")
    source_path = directory / "template.mjml"
    if source_path.exists() and not args.force:
        raise FileExistsError(f"Refusing to overwrite {source_path}; use --force")
    source_path.write_text(build(config))
    metadata = {
        "catalog_id": config["catalog_id"],
        "source_provider": config.get("source_provider", "really_good_emails"),
        "kind": "original_editable_draft",
        "subject": config["subject"],
        "preview_text": config["preview_text"],
        "hero_prompt": config["hero_prompt"],
        "asset_status": "local_unhosted",
        "review_status": "draft",
    }
    (directory / "meta.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(config["catalog_id"])


if __name__ == "__main__":
    main()
