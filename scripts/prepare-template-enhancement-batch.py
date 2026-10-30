#!/usr/bin/env python3
"""Fetch a bounded batch of provider screenshots for original image generation."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
WORKLIST = ROOT / "output/template-enhancement/worklist.jsonl"
CACHE = Path("/tmp/postwave-template-references")
HOSTS = {
    "really_good_emails": {"pro-really-good-emails.s3.eu-west-1.amazonaws.com"},
    "aura_build": {
        "hoirqrkdgbmvpwutwuwj.supabase.co",
        "hoirqrkdgbmvpwutwuwj-all.supabase.co",
    },
}


def source_url(record: dict) -> str:
    parsed = urlsplit(record["source_preview_url"])
    if parsed.scheme != "https" or parsed.hostname not in HOSTS[record["source_provider"]]:
        raise ValueError(f"Unexpected preview host for {record['catalog_id']}")
    if parsed.username or parsed.password or parsed.port or parsed.fragment:
        raise ValueError(f"Invalid preview URL for {record['catalog_id']}")
    if record["source_provider"] == "really_good_emails":
        if not parsed.path.startswith("/emails/"):
            raise ValueError("Unexpected RGE preview path")
    elif not parsed.path.startswith(("/storage/v1/object/public/preview-images/", "/storage/v1/object/public/chat-thumbnails/")):
        raise ValueError("Unexpected Aura preview path")
    host = parsed.hostname.replace("-all.supabase.co", ".supabase.co")
    return urlunsplit(("https", host, parsed.path, parsed.query, ""))


def fetch(record: dict, index: int) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{index:05d}.img"
    if path.is_file():
        try:
            with Image.open(path) as image:
                image.verify()
            return path
        except Exception:
            path.unlink()
    subprocess.run(
        ["curl", "-fsSL", "--retry", "2", "--max-time", "30", "--max-filesize", "10000000", source_url(record), "-o", str(path)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    with Image.open(path) as image:
        width, height = image.size
        if width < 100 or height < 100 or width * height > 30_000_000:
            raise ValueError(f"Unsupported preview dimensions for {record['catalog_id']}: {width}x{height}")
        image.verify()
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=5)
    parser.add_argument("--start-index", type=int, default=0)
    options = parser.parse_args()
    if options.count < 1 or options.count > 25 or options.start_index < 0:
        parser.error("count must be 1..25 and start-index must be nonnegative")
    jobs = []
    for index, line in enumerate(WORKLIST.open()):
        if index < options.start_index:
            continue
        record = json.loads(line)
        if record.get("deliverables", {}).get("editable_mjml") or record.get("deliverables", {}).get("original_hero_image"):
            continue
        dirname = record["catalog_id"].replace(":", "-")
        target = ROOT / "output/template-enhancement/items" / dirname
        if (target / "hero.png").is_file():
            continue
        path = fetch(record, index)
        jobs.append({
            "index": index,
            "catalog_id": record["catalog_id"],
            "reference_path": str(path),
            "target_dir": str(target),
            "prompt": record["brief"]["image_prompt"],
        })
        if len(jobs) >= options.count:
            break
    print(json.dumps(jobs, ensure_ascii=False))


if __name__ == "__main__":
    main()
