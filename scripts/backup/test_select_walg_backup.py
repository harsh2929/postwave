#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True

MODULE_PATH = Path(__file__).with_name("select-walg-backup.py")
SPEC = importlib.util.spec_from_file_location("select_walg_backup", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
parse_timestamp = MODULE.parse_timestamp
select_backup = MODULE.select_backup


class SelectWalgBackupTests(unittest.TestCase):
    def test_selects_newest_backup_completed_no_later_than_target(self) -> None:
        backups = [
            {"backup_name": "base_old", "finish_time": "2026-07-14T01:00:00Z"},
            {"backup_name": "base_right", "finish_time": "2026-07-14T02:59:59.5Z"},
            {"backup_name": "base_too_new", "finish_time": "2026-07-14T03:00:01Z"},
        ]
        target = datetime(2026, 7, 14, 3, 0, tzinfo=timezone.utc)

        selected = select_backup(backups, target)

        self.assertEqual(selected["name"], "base_right")
        self.assertEqual(selected["metadata"], backups[1])

    def test_rejects_target_older_than_every_completed_backup(self) -> None:
        with self.assertRaisesRegex(ValueError, "no completed base backup"):
            select_backup(
                [{"backup_name": "base_new", "finish_time": "2026-07-14T04:00:00Z"}],
                datetime(2026, 7, 14, 3, 0, tzinfo=timezone.utc),
            )

    def test_supports_walg_field_variants_and_offsets(self) -> None:
        selected = select_backup(
            [{"BackupName": "base_variant", "FinishTime": "2026-07-14T04:30:00+05:30"}],
            datetime(2026, 7, 13, 23, 30, tzinfo=timezone.utc),
        )
        self.assertEqual(selected["name"], "base_variant")

    def test_invalid_timestamp_returns_none(self) -> None:
        self.assertIsNone(parse_timestamp("not-a-timestamp"))
        self.assertIsNone(parse_timestamp(True))
        self.assertIsNone(parse_timestamp(float("inf")))

    def test_rejects_started_but_not_completed_backup(self) -> None:
        with self.assertRaisesRegex(ValueError, "no completed base backup"):
            select_backup(
                [{"backup_name": "base_incomplete", "start_time": "2026-07-14T02:00:00Z"}],
                datetime(2026, 7, 14, 3, 0, tzinfo=timezone.utc),
            )


if __name__ == "__main__":
    unittest.main()
