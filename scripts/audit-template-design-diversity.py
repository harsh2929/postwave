#!/usr/bin/env python3
"""Flag editable drafts whose section layouts repeat another draft.

The report is a review queue, not a visual quality score. It deliberately
ignores copy, colors, and image contents so a new picture alone cannot hide a
reused composition.
"""

from __future__ import annotations

import argparse
import difflib
import itertools
import json
import re
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ITEMS = ROOT / "output/template-enhancement/items"
DEFAULT_REPORT = ROOT / "output/template-enhancement/design-diversity.json"
BLOCK_CODES = {
    "mj-text": "T",
    "mj-image": "I",
    "mj-button": "B",
    "mj-divider": "D",
    "mj-spacer": "S",
    "mj-social": "O",
}


def topology(source: str) -> str:
    sections = re.findall(r"<mj-section\b[^>]*>(.*?)</mj-section>", source, re.S)
    # Most emails share a brand masthead and legal footer; compare their body.
    body = sections[1:-1]
    shapes = []
    for section in body:
        columns = re.findall(r"<mj-column\b[^>]*>(.*?)</mj-column>", section, re.S)
        shapes.append(
            "/".join(
                "".join(
                    BLOCK_CODES.get(tag, "?")
                    for tag in re.findall(r"<(mj-[a-z-]+)\b", column)
                )
                for column in columns
            )
        )
    return "|".join(shapes)


def audit(items: Path, near_threshold: float) -> dict:
    drafts = []
    for path in sorted(items.glob("*/template.mjml")):
        source = path.read_text()
        drafts.append({"item": path.parent.name, "topology": topology(source)})
    groups = defaultdict(list)
    for draft in drafts:
        groups[draft["topology"]].append(draft["item"])
    exact = [
        {"topology": shape, "items": names}
        for shape, names in groups.items()
        if shape and len(names) > 1
    ]
    near = []
    for first, second in itertools.combinations(drafts, 2):
        if first["topology"] == second["topology"]:
            continue
        score = difflib.SequenceMatcher(
            None, first["topology"], second["topology"]
        ).ratio()
        if score >= near_threshold:
            near.append({
                "items": [first["item"], second["item"]],
                "similarity": round(score, 3),
            })
    near.sort(key=lambda pair: (-pair["similarity"], pair["items"]))
    return {
        "draft_count": len(drafts),
        "exact_reuse_groups": exact,
        "near_reuse_pairs": near,
        "near_threshold": near_threshold,
        "note": "Review flagged pairs against their source captures and rendered previews. A matching topology is a warning, not proof of an identical design.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--items", type=Path, default=DEFAULT_ITEMS)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--near-threshold", type=float, default=0.94)
    args = parser.parse_args()
    report = audit(args.items, args.near_threshold)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({
        "draft_count": report["draft_count"],
        "exact_reuse_groups": len(report["exact_reuse_groups"]),
        "near_reuse_pairs": len(report["near_reuse_pairs"]),
        "report": str(args.report),
    }, indent=2))


if __name__ == "__main__":
    main()
