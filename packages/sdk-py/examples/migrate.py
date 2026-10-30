"""Kick off a Mailchimp → Moosewave migration.

Run::
    POSTWAVE_API_KEY=... POSTWAVE_TENANT=acme python examples/migrate.py
"""

from __future__ import annotations

import os
import time

from postwave import Moosewave


def main() -> None:
    pw = Moosewave(api_key=os.environ["POSTWAVE_API_KEY"], tenant_id=os.environ.get("POSTWAVE_TENANT"))

    auth = pw.migrations.start("mailchimp")
    print("Visit:", auth.authorize_url)

    job_id = os.environ.get("POSTWAVE_JOB_ID")
    if not job_id:
        print("Re-run with POSTWAVE_JOB_ID=<id-from-callback>")
        return

    discovery = pw.migrations.discover("mailchimp", job_id)
    print("Available audiences:", discovery.audiences)
    selected_audience_ids = [
        audience_id.strip()
        for audience_id in os.environ.get("MAILCHIMP_AUDIENCE_IDS", "").split(",")
        if audience_id.strip()
    ]
    if not selected_audience_ids:
        print("Re-run with MAILCHIMP_AUDIENCE_IDS=<comma-separated IDs selected from discovery>")
        return
    scoped_discovery = pw.migrations.discover("mailchimp", job_id, selected_audience_ids)
    print(
        f"Scoped inventory: {scoped_discovery.subscribers_count} subs, "
        f"{scoped_discovery.segments_count} segments"
    )

    pw.migrations.dry_run("mailchimp", job_id, selected_audience_ids)
    while True:
        job = pw.migrations.get(job_id)
        print(job.status, job.progress)
        if job.status in ("awaiting_confirmation", "failed"):
            break
        time.sleep(2)

    report = pw.migrations.verification(job_id)
    print(f"Would import {report.subscribers_imported} subscribers; data loss {report.data_loss_estimate_pct}%")

    pw.migrations.commit("mailchimp", job_id, selected_audience_ids)


if __name__ == "__main__":
    main()
