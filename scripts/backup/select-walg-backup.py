#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Select the newest completed WAL-G base backup no later than a PITR target."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from typing import Any


def parse_timestamp(value: object) -> datetime | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def select_backup(backups: list[dict[str, Any]], target: datetime) -> dict[str, Any]:
    eligible: list[tuple[datetime, str, dict[str, Any]]] = []
    for backup in backups:
        completed = parse_timestamp(
            backup.get("finish_time")
            or backup.get("FinishTime")
            or backup.get("time")
            or backup.get("Time")
        )
        name = backup.get("backup_name") or backup.get("BackupName") or backup.get("name")
        if completed is not None and completed <= target and isinstance(name, str):
            eligible.append((completed, name, backup))
    if not eligible:
        raise ValueError("no completed base backup is old enough for the requested recovery target")
    completed, name, backup = max(eligible, key=lambda item: item[0])
    return {"name": name, "completed_at": completed.isoformat(), "metadata": backup}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalog", type=Path, help="WAL-G backup-list --detail --json output")
    parser.add_argument("target", help="UTC RFC3339 recovery target")
    args = parser.parse_args()

    target = parse_timestamp(args.target)
    if target is None:
        parser.error("target is not a valid timestamp")
    try:
        parsed = json.loads(args.catalog.read_text(encoding="utf-8"))
        if not isinstance(parsed, list) or not all(isinstance(item, dict) for item in parsed):
            raise ValueError("WAL-G catalog must be a JSON array of objects")
        selected = select_backup(parsed, target)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(selected, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
