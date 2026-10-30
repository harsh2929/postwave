-- 1874_report_run_provenance.sql
--
-- Give a stored report result the two facts that make it interpretable.
--
-- `report_runs` recorded numbers and nothing about where they came from:
--
--   metric_version   WHICH definitions produced them. `campaign.open_rate` is
--                    opens/delivered today. If it ever becomes opens/sent,
--                    every run computed under the old rule still reads as "open
--                    rate" and nothing distinguishes them — so a
--                    quarter-over-quarter comparison silently mixes two
--                    different measurements and reports the difference as a
--                    result.
--
--   computed_as_of   AS OF WHEN the underlying data was current. A run at 09:00
--                    over a pipeline that last landed at 03:00 is a six-hour-old
--                    answer. Read as "now", it makes desktop and web disagree
--                    about the same saved report, and that disagreement is
--                    indistinguishable from a defect in whichever surface you
--                    happen to be looking at.
--
-- Both NULLABLE, and deliberately not backfilled. Existing rows were computed
-- before either fact was captured; inventing values would assert something we
-- cannot know, and a NULL that reads as "provenance unknown" is the honest
-- answer for a historical run. Clients render the stamp when present.

BEGIN;

ALTER TABLE report_runs
    ADD COLUMN IF NOT EXISTS metric_version text,
    ADD COLUMN IF NOT EXISTS computed_as_of timestamptz;

COMMENT ON COLUMN report_runs.metric_version IS
    'Fingerprint of the metric definitions in force when this run was computed '
    '(reporting.MetricRegistryVersion). Derived from the registry rather than '
    'hand-maintained, because a version someone must remember to bump is wrong '
    'exactly in the release where a formula changed. NULL for runs predating '
    'the column.';

COMMENT ON COLUMN report_runs.computed_as_of IS
    'How current the underlying data was, NOT when the run executed — '
    'started_at already says that. The gap between them is the answer''s age, '
    'and it is what lets two surfaces agree that they are showing the same '
    'thing. NULL for runs predating the column.';

COMMIT;
