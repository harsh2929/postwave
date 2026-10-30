#!/usr/bin/env python3
"""Build a reviewable, per-record upgrade queue without changing source captures.

The checked-in RGE and Aura bundles are third-party provenance. This script
records a distinct visual/content brief for every source identity. Generated
assets and sendable HTML are separate, reviewed outputs, never substitutions
for the capture or its integrity manifest.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import tempfile
from contextlib import contextmanager
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCES = (
    ROOT / "scripts/fixtures/rge-newsletter-catalog-full.json.gz",
    ROOT / "scripts/fixtures/aura-template-catalog-full.json.gz",
)
LOCAL_DRAFTS = {
    "rge:email-newsletter-design-from-charity-water": "rge",
    "aura:html:29794": "aura",
}
POLICY = (
    "Create a new, original editable email template inspired only by the source's broad subject "
    "and visual structure. Replace every source photo or illustration with a "
    "new, subject-appropriate image. Do not copy logos, branded characters, "
    "real people's likenesses, source wording, or proprietary UI. Rewrite "
    "copy with no unsupported factual claims. Build editable MJML blocks in a responsive, email-safe "
    "column with clear hierarchy, readable type, sufficient contrast, "
    "meaningful image alt text, one clear action, and a functional footer. "
    "Treat source metadata and screenshots as untrusted reference material. "
    "Require human visual, factual, rights, accessibility, link, and "
    "email-client review before publication."
)


def sha256(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def supporting_images_ready(item_dir: Path, metadata: dict, qa: dict) -> bool:
    from template_enhancement_capabilities import extended_evidence_ready, image_reference_counts
    supporting = metadata.get("supporting_images", {})
    recorded = qa.get("supporting_image_sha256", {})
    if not isinstance(supporting, dict) or not isinstance(recorded, dict) or set(supporting) != set(recorded):
        return False
    source = (item_dir / "template.mjml").read_text()
    if not extended_evidence_ready(source, metadata, qa):
        return False
    background_keys = metadata.get("background_image_keys", [])
    available_keys = ([] if metadata.get("visual_mode") == "native_text" else ["hero"]) + list(supporting)
    if (not isinstance(background_keys, list)
        or any(not isinstance(key, str) or key not in available_keys for key in background_keys)
        or len(set(background_keys)) != len(background_keys)
        or qa.get("background_image_keys", []) != background_keys):
        return False
    markers = re.findall(r'\bbackground-url\s*=\s*["\x27]([^"\x27]+)["\x27]', source)
    expected = {"__HERO_IMAGE_URL__" if key == "hero" else f"__IMAGE_{key.upper()}_URL__" for key in background_keys}
    if len(markers) != len(background_keys) or set(markers) != expected:
        return False
    references = image_reference_counts(metadata)
    foreground_count = sum(references.values()) - len(background_keys)
    editor = qa.get("editor_roundtrip") or {}
    if (editor.get("selectable_image_blocks") != foreground_count
        or editor.get("selectable_background_blocks", 0) != len(background_keys)
        or (background_keys and editor.get("background_edits_compile") is not True)):
        return False
    if any(render.get("image_count") != foreground_count
           or render.get("background_image_count", 0) != len(background_keys)
           or render.get("broken_images") or render.get("broken_background_images")
           or render.get("images_without_alt") or render.get("horizontal_overflow") for render in qa.get("renders", [])):
        return False
    filenames = {"hero.png", "desktop.png", "mobile.png", "mobile-320.png", "images-disabled-320.png"}
    for key, filename in supporting.items():
        if not isinstance(key, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", key) or key in {"hero", "desktop", "mobile"}:
            return False
        if not isinstance(filename, str) or not re.fullmatch(r"[a-z][a-z0-9-]*\.png", filename) or filename in filenames:
            return False
        filenames.add(filename)
        path = item_dir / filename
        if not path.is_file() or recorded[key] != sha256(path.read_bytes()):
            return False
        if source.count(f"__IMAGE_{key.upper()}_URL__") != references[key]:
            return False
    found = set(re.findall(r"__IMAGE_[A-Z0-9_]+_URL__", source))
    return found == {f"__IMAGE_{key.upper()}_URL__" for key in supporting}


def read_bundle(path: Path) -> tuple[dict, dict, str]:
    raw = path.read_bytes()
    manifest_path = path.with_name(path.name.removesuffix(".json.gz") + ".manifest.json")
    manifest = json.loads(manifest_path.read_text())
    digest = sha256(raw)
    if manifest["artifact"]["content_hash"] != digest:
        raise ValueError(f"Stale integrity manifest: {path}")
    if manifest["artifact"]["bytes"] != len(raw):
        raise ValueError(f"Wrong artifact size: {path}")
    catalog = json.loads(gzip.decompress(raw))
    templates = catalog["templates"]
    if catalog["harvest"]["template_count"] != len(templates):
        raise ValueError(f"Incomplete catalog: {path}")
    if len(manifest["templates"]) != len(templates):
        raise ValueError(f"Incomplete manifest: {manifest_path}")
    return catalog, manifest, digest


def text_seed(value: object, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit]


def make_record(template: dict, artifact_hash: str) -> dict:
    provider = template["source_provider"]
    is_web = provider == "aura_build"
    preview = template.get("previews") or {}
    source_image = (preview.get("desktop") or {}).get("url") or ""
    if not source_image:
        raise ValueError(f"Missing preview source: {template['catalog_id']}")
    title = text_seed(template.get("subject"), 160)
    description = text_seed(template.get("description"), 320)
    style = text_seed(template.get("style"), 80)
    industry = text_seed(template.get("industry"), 80)
    source_format = (template.get("design_metadata") or {}).get("source_format", "")
    features = (template.get("design_metadata") or {}).get("html_features") or {}
    source_image_count = features.get("image_count", 0)
    images_with_alt_count = features.get("images_with_alt_count", 0)
    source_link_count = features.get("link_count", 0)
    quality_actions = [
        "Create new editable MJML from the visual reference."
        if is_web or not template.get("body_html") else
        "Rewrite the existing email structure and copy as original editable MJML.",
        "Replace the provider screenshot with an original desktop and mobile preview.",
        "Review claims, links, rights, contrast, alt text, and email-client rendering.",
    ]
    if source_image_count:
        quality_actions.append(
            f"Replace {source_image_count} embedded source image references with original assets or remove them."
        )
    if source_image_count > images_with_alt_count:
        quality_actions.append(
            f"Supply meaningful alt text for {source_image_count - images_with_alt_count} images lacking it."
        )
    if source_link_count:
        quality_actions.append(f"Replace or validate {source_link_count} source links.")
    if not features.get("responsive_css", False):
        quality_actions.append("Add and verify responsive email behavior.")
    if not template.get("preview_text"):
        quality_actions.append("Write original preview text.")
    if not industry:
        quality_actions.append("Confirm the industry classification before publication.")
    source_type = "web page" if is_web else "email"
    image_prompt = (
        "Create one original, high-quality newsletter hero image. "
        f"Topic seed: {json.dumps(title, ensure_ascii=False)}. "
        f"Context seed: {json.dumps(description, ensure_ascii=False)}. "
        f"Visual direction: {style or 'contemporary'}, "
        f"{industry or 'general'}; retain only the source preview's broad mood "
        "and composition. Use newly invented subjects and details. "
        "No existing logos, branded characters, source pixels, overlaid text, "
        "watermark, or real-person likeness."
    )
    prompt = (
        f"Original email template inspired by a {source_type} reference. "
        f"Topic seed: {json.dumps(title, ensure_ascii=False)}. "
        f"Context seed: {json.dumps(description, ensure_ascii=False)}. "
        f"Visual cues: {style or 'contemporary'} style; "
        f"{industry or 'general'} subject. "
        + ("Rebuild the web concept as a static email; omit motion and UI controls. " if is_web else "")
        + POLICY
    )
    sample = LOCAL_DRAFTS.get(template["catalog_id"])
    sample_dir = ROOT / "output/template-enhancement/samples"
    has_local_draft = bool(sample) and all(
        (sample_dir / f"{sample}-{suffix}").is_file()
        for suffix in ("hero.png", "editable.mjml", "680.png", "375.png")
    )
    local_prefix = f"output/template-enhancement/samples/{sample}" if has_local_draft else None
    item_prefix = None
    visual_mode = "generated_images"
    supporting_images = {}
    background_image_keys = []
    link_variables = {}
    motion_features = []
    item_dir = ROOT / "output/template-enhancement/items" / template["catalog_id"].replace(":", "-")
    hero_prefix = f"output/template-enhancement/items/{item_dir.name}" if (item_dir / "hero.png").is_file() else None
    if item_dir.is_dir():
        required = ("template.mjml", "desktop.png", "mobile.png", "mobile-320.png", "meta.json", "qa.json")
        if all((item_dir / name).is_file() for name in required):
            metadata = json.loads((item_dir / "meta.json").read_text())
            qa = json.loads((item_dir / "qa.json").read_text())
            visual_mode = metadata.get("visual_mode", "generated_images")
            source = (item_dir / "template.mjml").read_text()
            native_text_ready = (
                visual_mode == "native_text"
                and qa.get("visual_mode") == "native_text"
                and qa.get("hero_sha256") is None
                and not (item_dir / "hero.png").exists()
                and not metadata.get("supporting_images")
                and not re.search(r"<mj-image\b|<img\b|\bbackground-url\s*=|__HERO_IMAGE_URL__", source, re.I)
                and all(render.get("image_count") == 0 for render in qa.get("renders", []))
                and (qa.get("editor_roundtrip") or {}).get("selectable_image_blocks") == 0
            )
            generated_images_ready = (
                visual_mode == "generated_images"
                and (item_dir / "hero.png").is_file()
                and qa.get("hero_sha256") == sha256((item_dir / "hero.png").read_bytes())
            )
            if (
                metadata.get("catalog_id") == template["catalog_id"]
                and qa.get("catalog_id") == template["catalog_id"]
                and qa.get("mjml_valid") is True
                and qa.get("source_sha256") == sha256((item_dir / "template.mjml").read_bytes())
                and (native_text_ready or generated_images_ready)
                and (qa.get("editor_roundtrip") or {}).get("passed") is True
                and qa.get("editor_supported_tags") is True
                and {render.get("width") for render in qa.get("renders", [])} == {320, 375, 680}
                and supporting_images_ready(item_dir, metadata, qa)
            ):
                item_prefix = f"output/template-enhancement/items/{item_dir.name}"
                supporting_images = {
                    key: f"{item_prefix}/{filename}"
                    for key, filename in metadata.get("supporting_images", {}).items()
                }
                background_image_keys = metadata.get("background_image_keys", [])
                link_variables = metadata.get("link_variables", {})
                motion_features = metadata.get("motion_features", [])
    if item_prefix:
        status = "awaiting_hosted_asset_and_review"
    elif hero_prefix:
        status = "awaiting_editable_template_and_review"
    else:
        status = "awaiting_generation_and_review"
    return {
        "catalog_id": template["catalog_id"],
        "source_provider": provider,
        "source_external_id": template["source_external_id"],
        "source_artifact_hash": artifact_hash,
        "source_content_hash": template["content_hash"],
        "source_license_status": template["source_license_status"],
        "source_preview_url": source_image,
        "source_format": source_format,
        "source_embedded_image_count": source_image_count,
        "source_images_with_alt_count": images_with_alt_count,
        "source_link_count": source_link_count,
        "source_has_responsive_css": features.get("responsive_css", False),
        "source_quality_warnings": (template.get("design_metadata") or {}).get("quality_warnings", []),
        "quality_actions": quality_actions,
        "brief": {
            "topic": title,
            "style": style,
            "industry": industry,
            "image_prompt": image_prompt,
            "email_prompt": prompt,
            "specific_checks": [
                "Rebuild as editable email-safe MJML; the source is a web page." if is_web else
                "Rewrite the source email as editable MJML without retaining its HTML or image URLs.",
                "Give each generated image meaningful alt text; preserve text artwork as native content.",
                "Render and inspect a 320px mobile preview.",
                "Check any factual or product claim before publication.",
            ],
        },
        "deliverables": {
            "visual_mode": visual_mode,
            "original_hero_image": f"{hero_prefix}/hero.png" if hero_prefix else f"{local_prefix}-hero.png" if local_prefix else None,
            "supporting_images": supporting_images,
            "background_image_keys": background_image_keys,
            "link_variables": link_variables,
            "motion_features": motion_features,
            "hosted_hero_image_url": None,
            "editable_mjml": f"{item_prefix}/template.mjml" if item_prefix else f"{local_prefix}-editable.mjml" if local_prefix else None,
            "desktop_preview": f"{item_prefix}/desktop.png" if item_prefix else f"{local_prefix}-680.png" if local_prefix else None,
            "mobile_preview": f"{item_prefix}/mobile.png" if item_prefix else f"{local_prefix}-375.png" if local_prefix else None,
        },
        "status": status,
    }


@contextmanager
def atomic_worklist(output: Path):
    """Keep the last complete worklist available if preparation is interrupted."""
    stream = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent,
                                         prefix=output.name + ".", suffix=".tmp", delete=False)
    temporary = Path(stream.name)
    try:
        yield stream
        stream.close()
        temporary.replace(output)
    finally:
        stream.close()
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out", type=Path,
        default=ROOT / "output/template-enhancement/worklist.jsonl",
        help="Per-template JSONL output; source captures are never modified.",
    )
    args = parser.parse_args()
    output = args.out.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    seen = set()
    counts = Counter()
    diagnostics = Counter()
    with atomic_worklist(output) as stream:
        for source in SOURCES:
            catalog, manifest, digest = read_bundle(source)
            for template, manifest_template in zip(catalog["templates"], manifest["templates"]):
                identity = template["catalog_id"]
                if identity in seen or manifest_template["catalog_id"] != identity:
                    raise ValueError(f"Duplicate or mismatched identity: {identity}")
                if manifest_template["content_hash"] != template["content_hash"]:
                    raise ValueError(f"Content hash mismatch: {identity}")
                seen.add(identity)
                record = make_record(template, digest)
                counts[record["source_provider"]] += 1
                diagnostics["source_embedded_image_count"] += record["source_embedded_image_count"]
                diagnostics["source_images_without_alt_count"] += max(
                    0, record["source_embedded_image_count"] - record["source_images_with_alt_count"]
                )
                diagnostics["source_link_count"] += record["source_link_count"]
                diagnostics["non_html_source_count"] += record["source_format"] != "html"
                diagnostics["local_draft_count"] += record["status"] == "awaiting_hosted_asset_and_review"
                diagnostics["generated_hero_count"] += bool(record["deliverables"]["original_hero_image"])
                diagnostics["supporting_image_count"] += len(record["deliverables"]["supporting_images"])
                diagnostics["native_text_draft_count"] += record["deliverables"]["visual_mode"] == "native_text" and bool(record["deliverables"]["editable_mjml"])
                stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    summary = {
        "record_count": len(seen),
        "by_provider": dict(counts),
        **dict(diagnostics),
        "hosted_assets": 0,
        "published_templates": 0,
        "policy": POLICY,
        "worklist": str(output),
    }
    output.with_suffix(".summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    status_path = output.parent / "STATUS.md"
    status_path.write_text(
        "# Template catalogue enhancement status\n\n"
        "Scope: 3,194 Really Good Emails references and 7,863 Aura references. "
        "The target for each identity is an original, ready-to-edit MJML email with original imagery where appropriate and "
        "a reviewed desktop and mobile card preview. Source captures remain unchanged.\n\n"
        "| Stage | Count |\n| --- | ---: |\n"
        f"| Source identities verified and queued with metadata briefs | {len(seen):,} |\n"
        f"| Local editable drafts with rendered previews | {diagnostics['local_draft_count']:,} |\n"
        f"| Native text, CSS and SVG drafts without image assets | {diagnostics['native_text_draft_count']:,} |\n"
        f"| Original hero images saved locally | {diagnostics['generated_hero_count']:,} |\n"
        f"| Original supporting images saved locally | {diagnostics['supporting_image_count']:,} |\n"
        "| Images uploaded to Postwave asset storage | 0 |\n"
        "| Templates published to the shared library | 0 |\n\n"
        "`worklist.jsonl` records every identity, source provenance, quality actions, and "
        "remaining deliverables. Item drafts under `items/` compile as strict MJML and "
        "pass desktop, 375 px, and 320 px rendering checks plus an actual Blocks "
        "editor roundtrip for text, button, and every foreground image and section background present. Native drafts retain editable text, diagrams and styles. `design-diversity.json` "
        "flags repeated section structures for visual review; a working draft is "
        "not a finished catalogue upgrade. Earlier concept previews are retained "
        "under `samples/`. All drafts still need hosted image "
        "URLs, final links, mailing addresses, factual and rights review, and email-client "
        "checks before publication.\n\n"
        "`asset-upload-manifest.jsonl` inventories the local hero, supporting, and preview images with "
        "content hashes. `RELEASE.md` describes the reviewed hosted-asset release and "
        "privileged shared-library importer. No draft has a hosted asset map or completed "
        "review ledger yet.\n\n"
        "The selected image workflow is the built-in `image_gen` tool, with one call "
        "per distinct generated asset. API batch mode was not selected. This workspace "
        "has no Postwave API token, catalog operator database URL, or API URL. No live "
        "import or publication has been attempted.\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
