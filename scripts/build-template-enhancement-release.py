#!/usr/bin/env python3
"""Inventory generated assets or compile reviewed drafts for the shared library.

The default inventory is safe to run while designs are still drafts. A release
requires a hosted URL and matching digest for every image, plus explicit review
evidence for each item. It emits trusted import records; it does not publish.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "output/template-enhancement"
IMAGE_FILES = {"hero": "hero.png", "desktop": "desktop.png", "mobile": "mobile.png"}
RESERVED_IMAGE_FILES = set(IMAGE_FILES.values()) | {"mobile-320.png", "images-disabled-320.png"}
REVIEW_CHECKS = ("visual", "facts", "rights", "accessibility", "links", "email_clients")
MAILING_ADDRESS_MARKERS = (
    "Add your mailing address before sending",
    "Ajoutez votre adresse postale avant l'envoi",
)


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def read_worklist(path: Path) -> dict[str, dict]:
    records = {}
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            record = json.loads(line)
            catalog_id = record["catalog_id"]
            if catalog_id in records:
                raise ValueError(f"Duplicate worklist identity: {catalog_id}")
            records[catalog_id] = record
    return records


def item_files(directory: Path, record: dict) -> dict:
    from template_enhancement_capabilities import extended_evidence_ready
    catalog_id = record["catalog_id"]
    if directory.name != catalog_id.replace(":", "-"):
        raise ValueError(f"Item directory does not match identity: {directory}")
    metadata = read_json(directory / "meta.json")
    qa = read_json(directory / "qa.json")
    mjml = (directory / "template.mjml").read_text(encoding="utf-8")
    if not extended_evidence_ready(mjml, metadata, qa):
        raise ValueError(f"Named action or motion evidence is inconsistent: {catalog_id}")
    visual_mode = metadata.get("visual_mode", "generated_images")
    if visual_mode not in {"generated_images", "native_text"}:
        raise ValueError(f"Unknown template visual mode: {catalog_id}")
    native_text = visual_mode == "native_text"
    background_keys = metadata.get("background_image_keys", [])
    available_keys = ([] if native_text else ["hero"]) + list(metadata.get("supporting_images", {}))
    if (not isinstance(background_keys, list)
        or any(not isinstance(key, str) or key not in available_keys for key in background_keys)
        or len(set(background_keys)) != len(background_keys)
        or qa.get("background_image_keys", []) != background_keys):
        raise ValueError(f"Background image evidence is inconsistent: {catalog_id}")
    background_markers = re.findall(r'\bbackground-url\s*=\s*["\x27]([^"\x27]+)["\x27]', mjml)
    expected_background_markers = {"__HERO_IMAGE_URL__" if key == "hero" else f"__IMAGE_{key.upper()}_URL__" for key in background_keys}
    if len(background_markers) != len(background_keys) or set(background_markers) != expected_background_markers:
        raise ValueError(f"Background image markup is inconsistent: {catalog_id}")
    if native_text and (
        qa.get("visual_mode") != "native_text"
        or qa.get("hero_sha256") is not None
        or (directory / "hero.png").exists()
        or metadata.get("supporting_images")
        or re.search(r"<mj-image\b|<img\b|\bbackground-url\s*=|__HERO_IMAGE_URL__", mjml, re.I)
        or any(render.get("image_count") != 0 for render in qa.get("renders", []))
        or (qa.get("editor_roundtrip") or {}).get("selectable_image_blocks") != 0
    ):
        raise ValueError(f"Native text image evidence is inconsistent: {catalog_id}")
    if metadata.get("catalog_id") != catalog_id or qa.get("catalog_id") != catalog_id:
        raise ValueError(f"Metadata identity mismatch: {catalog_id}")
    if metadata.get("source_provider") != record["source_provider"]:
        raise ValueError(f"Source provider mismatch: {catalog_id}")
    if qa.get("source_sha256") != digest(mjml.encode("utf-8")):
        raise ValueError(f"MJML changed after QA: {catalog_id}")
    if not qa.get("mjml_valid") or not qa.get("editor_supported_tags"):
        raise ValueError(f"MJML/editor validation missing: {catalog_id}")
    if (qa.get("editor_roundtrip") or {}).get("passed") is not True:
        raise ValueError(f"Blocks editor roundtrip missing: {catalog_id}")
    if {render.get("width") for render in qa.get("renders", [])} != {320, 375, 680}:
        raise ValueError(f"Desktop/mobile renders missing: {catalog_id}")
    if any(render.get("broken_images") or render.get("broken_background_images") or render.get("images_without_alt") or render.get("horizontal_overflow") for render in qa["renders"]):
        raise ValueError(f"Render QA failed: {catalog_id}")
    if (not native_text and mjml.count("__HERO_IMAGE_URL__") != metadata.get("image_reference_counts", {}).get("hero", 1)) or "__CTA_URL__" not in mjml:
        raise ValueError(f"Expected image or CTA marker missing: {catalog_id}")
    if "{{unsubscribe_url}}" not in mjml or not any(marker in mjml for marker in MAILING_ADDRESS_MARKERS):
        raise ValueError(f"Required footer marker missing: {catalog_id}")
    images = {}
    for variant, filename in IMAGE_FILES.items():
        if native_text and variant == "hero":
            continue
        image = directory / filename
        data = image.read_bytes()
        if not data.startswith(bytes.fromhex("89504e470d0a1a0a")):
            raise ValueError(f"Invalid local PNG: {image}")
        images[variant] = {"path": str(image.relative_to(ROOT)), "sha256": digest(data), "bytes": len(data)}
    if not native_text and qa.get("hero_sha256") != images["hero"]["sha256"]:
        raise ValueError(f"Hero changed after QA: {catalog_id}")
    supporting = metadata.get("supporting_images", {})
    if not isinstance(supporting, dict):
        raise ValueError(f"Invalid supporting image metadata: {catalog_id}")
    qa_supporting = qa.get("supporting_image_sha256", {})
    if not isinstance(qa_supporting, dict) or set(qa_supporting) != set(supporting):
        raise ValueError(f"Supporting image QA is incomplete: {catalog_id}")
    filenames = set(RESERVED_IMAGE_FILES)
    for key, filename in supporting.items():
        if not isinstance(key, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", key) or key in IMAGE_FILES:
            raise ValueError(f"Invalid supporting image key: {catalog_id} {key}")
        if not isinstance(filename, str) or not re.fullmatch(r"[a-z][a-z0-9-]*\.png", filename) or filename in filenames:
            raise ValueError(f"Invalid supporting image filename: {catalog_id} {filename}")
        filenames.add(filename)
        marker = f"__IMAGE_{key.upper()}_URL__"
        if mjml.count(marker) != metadata.get("image_reference_counts", {}).get(key, 1):
            raise ValueError(f"Supporting image marker missing or repeated: {catalog_id} {marker}")
        image = directory / filename
        data = image.read_bytes()
        if not data.startswith(bytes.fromhex("89504e470d0a1a0a")):
            raise ValueError(f"Invalid local PNG: {image}")
        images[key] = {"path": str(image.relative_to(ROOT)), "sha256": digest(data), "bytes": len(data)}
        if qa_supporting[key] != images[key]["sha256"]:
            raise ValueError(f"Supporting image changed after QA: {catalog_id} {key}")
    declared_markers = {f"__IMAGE_{key.upper()}_URL__" for key in supporting}
    found_markers = set(re.findall(r"__IMAGE_[A-Z0-9_]+_URL__", mjml))
    if found_markers != declared_markers:
        raise ValueError(f"Undeclared supporting image marker: {catalog_id}")
    foreground_count = len(re.findall(r'<mj-image\b', mjml))
    editor = qa["editor_roundtrip"]
    if (editor.get("selectable_image_blocks") != foreground_count
        or editor.get("selectable_background_blocks", 0) != len(background_keys)
        or (background_keys and editor.get("background_edits_compile") is not True)):
        raise ValueError(f"Image editing evidence is inconsistent: {catalog_id}")
    for render in qa["renders"]:
        if (render.get("image_count") != foreground_count
            or render.get("background_image_count", 0) != len(background_keys)):
            raise ValueError(f"Rendered image evidence is inconsistent: {catalog_id}")
        if render.get("screenshot") not in {"desktop.png", "mobile.png", "mobile-320.png"}:
            raise ValueError(f"Unexpected render path: {catalog_id}")
        if not (directory / render["screenshot"]).is_file():
            raise ValueError(f"Missing render file: {catalog_id}")
    return {"metadata": metadata, "qa": qa, "mjml": mjml, "images": images}


def inventory(worklist: dict[str, dict], items_dir: Path) -> list[dict]:
    result = []
    for directory in sorted(path for path in items_dir.iterdir() if path.is_dir()):
        metadata = read_json(directory / "meta.json")
        catalog_id = metadata["catalog_id"]
        if catalog_id not in worklist:
            raise ValueError(f"Item absent from worklist: {catalog_id}")
        files = item_files(directory, worklist[catalog_id])
        result.append({"catalog_id": catalog_id, "source_provider": worklist[catalog_id]["source_provider"],
                       "source_external_id": worklist[catalog_id]["source_external_id"],
                       "mjml_sha256": files["qa"]["source_sha256"], "images": files["images"]})
    return result


def hosted_url(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label}: hosted HTTPS URL is required")
    url = urlsplit(value)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.fragment:
        raise ValueError(f"{label}: hosted HTTPS URL is required")
    if url.hostname in {"localhost", "example.com", "example.invalid"} or url.hostname.endswith(".invalid"):
        raise ValueError(f"{label}: placeholder host is not allowed")
    try:
        address = ipaddress.ip_address(url.hostname)
    except ValueError:
        pass
    else:
        if not address.is_global:
            raise ValueError(f"{label}: public image URL is required")
    return value


def release_item(entry: dict, worklist: dict, files: dict, hosted: dict, review: dict) -> dict:
    catalog_id = entry["catalog_id"]
    for variant in files["images"]:
        target = hosted.get(variant)
        if not isinstance(target, dict) or target.get("sha256") != files["images"][variant]["sha256"]:
            raise ValueError(f"Hosted {variant} digest missing or stale: {catalog_id}")
        hosted_url(target.get("url"), f"{catalog_id} {variant}")
    if review.get("mjml_sha256") != entry["mjml_sha256"]:
        raise ValueError(f"Review does not match current MJML: {catalog_id}")
    for variant in files["images"]:
        if review.get(f"{variant}_sha256") != files["images"][variant]["sha256"]:
            label = f"{variant} preview" if variant in {"desktop", "mobile"} else f"{variant} image"
            raise ValueError(f"Review does not match current {label}: {catalog_id}")
    if not isinstance(review.get("reviewer"), str) or not review["reviewer"].strip():
        raise ValueError(f"Named reviewer required: {catalog_id}")
    try:
        reviewed_at = datetime.fromisoformat(review["reviewed_at"].replace("Z", "+00:00"))
    except (KeyError, AttributeError, ValueError) as exc:
        raise ValueError(f"Valid reviewed_at required: {catalog_id}") from exc
    if reviewed_at.tzinfo is None or reviewed_at > datetime.now(timezone.utc):
        raise ValueError(f"Past timezone-aware reviewed_at required: {catalog_id}")
    if any(review.get("checks", {}).get(check) is not True for check in REVIEW_CHECKS):
        raise ValueError(f"All review checks required: {catalog_id}")
    source = files["mjml"]
    mjml = source.replace("__CTA_URL__", "{{ cta_url }}")
    if "hero" in files["images"]:
        mjml = mjml.replace("__HERO_IMAGE_URL__", hosted["hero"]["url"])
    for key in files["metadata"].get("supporting_images", {}):
        mjml = mjml.replace(f"__IMAGE_{key.upper()}_URL__", hosted[key]["url"])
    for marker in MAILING_ADDRESS_MARKERS:
        mjml = mjml.replace(marker, "{{ mailing_address }}")
    if re.search(r"__[A-Z0-9_]+__", mjml):
        raise ValueError(f"Unresolved build marker: {catalog_id}")
    metadata = files["metadata"]
    source_record = worklist[catalog_id]
    slug_base = "catalog-editable-" + catalog_id.replace(":", "-")
    slug = slug_base if len(slug_base) <= 80 else slug_base[:67].rstrip("-") + "-" + hashlib.sha256(catalog_id.encode()).hexdigest()[:12]
    return {
        "slug": slug,
        "name": metadata["subject"],
        "description": metadata["preview_text"],
        "category": "newsletter" if source_record["source_provider"] == "really_good_emails" else "marketing",
        "subject": metadata["subject"],
        "preview_text": metadata["preview_text"],
        "body_mjml": mjml,
        "variables": [
            {"name": "cta_url", "label": "Button destination"},
            {"name": "mailing_address", "label": "Mailing address"},
            *({"name": name, "label": label} for name, label in metadata.get("link_variables", {}).items()),
        ],
        "tags": ["original", "editable"],
        "template_kind": "editable",
        "source_provider": "postwave",
        "source_external_id": "enhancement:" + catalog_id,
        "source_license_status": "owned",
        "thumbnail_url": hosted["desktop"]["url"],
        "source_metadata": {"inspired_by": {"catalog_id": catalog_id,
            "provider": source_record["source_provider"],
            "external_id": source_record["source_external_id"],
            "source_artifact_hash": source_record["source_artifact_hash"],
            "source_content_hash": source_record["source_content_hash"]}},
        "design_metadata": {"visual_mode": metadata.get("visual_mode", "generated_images"),
            "background_image_keys": metadata.get("background_image_keys", []),
            **({"image_reference_counts": metadata["image_reference_counts"]} if "image_reference_counts" in metadata else {}),
            **({"image_asset_urls": {key: hosted[key]["url"] for key in metadata["image_reference_counts"]}} if "image_reference_counts" in metadata else {}),
            **({"interactive_gallery": metadata["interactive_gallery"]} if "interactive_gallery" in metadata else {}),
            **({"interactive_pizza": metadata["interactive_pizza"]} if "interactive_pizza" in metadata else {}),
            "motion_features": metadata.get("motion_features", []),
            "asset_digests": {key: image["sha256"] for key, image in files["images"].items()},
            "has_desktop_preview": True,
            "has_mobile_preview": True,
            "mobile_preview_url": hosted["mobile"]["url"],
            "review": {"reviewer": review["reviewer"].strip(), "reviewed_at": review["reviewed_at"],
                       "checks": {check: True for check in REVIEW_CHECKS}}},
        "generation_metadata": {"image_source": "native_text" if metadata.get("visual_mode") == "native_text" else "built_in_imagegen", "original_design": True},
        "review_status": "approved",
        "quality_score": 0.85,
        "content_hash": digest(mjml.encode("utf-8")),
        "industry": source_record["brief"]["industry"],
        "style": source_record["brief"]["style"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worklist", type=Path, default=BASE / "worklist.jsonl")
    parser.add_argument("--items-dir", type=Path, default=BASE / "items")
    parser.add_argument("--output", type=Path, default=BASE / "asset-upload-manifest.jsonl")
    parser.add_argument("--hosted-assets", type=Path)
    parser.add_argument("--reviews", type=Path)
    args = parser.parse_args()
    if bool(args.hosted_assets) != bool(args.reviews):
        parser.error("--hosted-assets and --reviews must be supplied together")
    worklist = read_worklist(args.worklist)
    entries = inventory(worklist, args.items_dir)
    if args.hosted_assets:
        hosted = read_json(args.hosted_assets)
        reviews = read_json(args.reviews)
        unknown = (set(hosted) | set(reviews)) - {entry["catalog_id"] for entry in entries}
        if unknown:
            raise ValueError(f"Unknown release identities: {sorted(unknown)}")
        selected = set(hosted) & set(reviews)
        if not selected:
            raise ValueError("Release has no hosted and reviewed items")
        if selected != set(hosted) or selected != set(reviews):
            raise ValueError("Every reviewed item must have a matching hosted asset entry")
        rows = []
        for entry in entries:
            catalog_id = entry["catalog_id"]
            if catalog_id in selected:
                directory = args.items_dir / catalog_id.replace(":", "-")
                files = item_files(directory, worklist[catalog_id])
                rows.append(release_item(entry, worklist, files, hosted[catalog_id], reviews[catalog_id]))
    else:
        rows = entries
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows), encoding="utf-8")
    print(json.dumps({"mode": "release" if args.hosted_assets else "asset_inventory", "records": len(rows), "output": str(args.output)}))


if __name__ == "__main__":
    main()
