#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Restore the staging services recorded at pause time. Read-only unless --apply.

Requires Python 3.9+, AWS CLI v2 and curl. Uses the active AWS_PROFILE/default
credentials. Never builds images, runs schema migrations or reads secret values.
"""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def log(message):
    print(message, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=Path(__file__).resolve().parent.parent / "paused-2026-10-13.json")
    parser.add_argument("--apply", action="store_true", help="Start the database and restore recorded service counts.")
    args = parser.parse_args()
    record = json.loads(args.snapshot.read_text())
    require(record["schema_version"] == 1, "Unsupported snapshot format")
    require(record["account_id"] == "700845118150" and record["region"] == "us-west-2"
            and record["cluster"] == "postwave-staging"
            and record["project_tag"] == "moosewave-staging"
            and record["database_instance_id"] == "i-05bfdae3f352828b4",
            "Snapshot does not describe the recorded Moosewave staging environment")
    expected_names = {"postwave-" + n for n in (
        "clamav", "listmonk", "voice", "deliverability", "campaign-assurance",
        "automation", "migration", "api", "web", "ops")}
    saved = {s["name"]: s for s in record["services"]}
    require(set(saved) == expected_names and len(record["services"]) == 10,
            "Snapshot must contain all 10 recorded services exactly once")
    require(all(s["desired_count"] == 1 for s in saved.values()), "Unexpected recorded desired count")
    groups = record["start_groups"]
    require(groups == [
        ["postwave-clamav", "postwave-listmonk"],
        ["postwave-voice", "postwave-deliverability", "postwave-campaign-assurance", "postwave-automation", "postwave-migration"],
        ["postwave-api"], ["postwave-web", "postwave-ops"]], "Unexpected startup order")
    env = dict(os.environ, AWS_PAGER="", AWS_CLI_AUTO_PROMPT="off", AWS_USE_DUALSTACK_ENDPOINT="false")
    endpoint_mode = env.get("STAGING_AWS_ENDPOINTS", "default")
    require(endpoint_mode in ("default", "dualstack"), "STAGING_AWS_ENDPOINTS must be default or dualstack")

    def aws(service, operation, *arguments, region=None):
        region = region or record["region"]
        cmd = ["aws", "--region", region, "--cli-connect-timeout", "15", "--cli-read-timeout", "45"]
        if endpoint_mode == "dualstack":
            cmd += ["--endpoint-url", f"https://{service}.{region}.api.aws"]
        cmd += [service, operation, *arguments, "--output", "json"]
        result = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=240)
        require(result.returncode == 0, f"AWS {service} {operation} failed: {result.stderr.strip()}")
        return json.loads(result.stdout)

    def tagged(resource, name):
        tags = resource.get("Tags", resource.get("tags", []))
        require(any(t.get("Key", t.get("key")) == "Project" and
                    t.get("Value", t.get("value")) == "moosewave-staging" for t in tags),
                f"Missing staging ownership tag: {name}")

    cluster = record["cluster"]
    instance_id = record["database_instance_id"]

    def instance():
        return aws("ec2", "describe-instances", "--instance-ids", instance_id)["Reservations"][0]["Instances"][0]

    def services(names):
        result = aws("ecs", "describe-services", "--cluster", cluster, "--services", *names, "--include", "TAGS")
        require(not result.get("failures"), f"ECS service lookup failed: {result.get('failures')}")
        rows = {s["serviceName"]: s for s in result["services"]}
        require(set(rows) == set(names), "Incomplete ECS service lookup")
        for name, row in rows.items():
            tagged(row, name)
            require(row["status"] == "ACTIVE" and row["taskDefinition"] == saved[name]["task_definition"],
                    f"Service definition changed since pause: {name}; review it before resuming")
            require(row["desiredCount"] in (0, saved[name]["desired_count"]), f"Unexpected desired count: {name}")
        return rows

    log("Checking account, ownership, service definitions, database and images (read-only)...")
    require(aws("sts", "get-caller-identity")["Account"] == record["account_id"], "Wrong AWS account")
    for name in ("moosewave-staging-base", "moosewave-staging-services"):
        stack = aws("cloudformation", "describe-stacks", "--stack-name", name)["Stacks"][0]
        tagged(stack, name)
        require(stack["StackStatus"] in ("CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"),
                f"Stack is changing or unhealthy: {name} {stack['StackStatus']}")
        if name.endswith("-base"):
            outputs = {o["OutputKey"]: o["OutputValue"] for o in stack["Outputs"]}
            require(outputs.get("ClusterName") == cluster and outputs.get("DbInstanceId") == instance_id,
                    "Base stack resources changed since pause")
        else:
            flags = [p for p in stack["Parameters"] if p["ParameterKey"].startswith("Deploy")]
            require(len(flags) == 10 and all(p["ParameterValue"] == "true" for p in flags),
                    "Services stack deploy flags changed since pause")
    cluster_result = aws("ecs", "describe-clusters", "--clusters", cluster, "--include", "TAGS")
    require(not cluster_result.get("failures") and len(cluster_result["clusters"]) == 1, "Cluster lookup failed")
    tagged(cluster_result["clusters"][0], cluster)
    live_names = {a.rsplit("/", 1)[-1] for a in aws("ecs", "list-services", "--cluster", cluster)["serviceArns"]}
    require(live_names == expected_names, "Service inventory changed; update the restart plan before proceeding")
    current = services(list(saved))
    db = instance()
    tagged(db, instance_id)
    require(db["State"]["Name"] in ("stopped", "running"), "Database is in transition; wait and retry")
    require(db.get("PrivateIpAddress") == record["database_private_ip"], "Database private IP changed")
    require(any(b.get("Ebs", {}).get("VolumeId") == record["database_volume_id"] for b in db["BlockDeviceMappings"]),
            "Recorded database volume is not attached")
    ids = aws("codebuild", "list-builds-for-project", "--project-name", "moosewave-staging-images",
              "--sort-order", "DESCENDING", region="us-east-1")["ids"]
    for offset in range(0, len(ids), 100):
        builds = aws("codebuild", "batch-get-builds", "--ids", *ids[offset:offset + 100], region="us-east-1")["builds"]
        require(not any(b["buildStatus"] == "IN_PROGRESS" for b in builds), "A staging image build is active; let it finish first")
    health_checked = set()
    for name, row in saved.items():
        definition = aws("ecs", "describe-task-definition", "--task-definition", row["task_definition"])["taskDefinition"]
        require(definition["status"] == "ACTIVE", f"Task definition is inactive: {name}")
        if any(c.get("essential", True) and c.get("healthCheck") for c in definition["containerDefinitions"]):
            health_checked.add(name)
        images = sorted({c["image"] for c in definition["containerDefinitions"]})
        require(images == row["images"], f"Images differ from snapshot: {name}")
        for image in images:
            match = re.fullmatch(r"700845118150\.dkr\.ecr\.us-west-2\.amazonaws\.com/([a-z0-9/-]+)@(sha256:[0-9a-f]{64})", image)
            require(match is not None, f"Expected a pinned staging ECR image: {name}")
            repository, digest = match.groups()
            aws("ecr", "describe-images", "--repository-name", repository, "--image-ids", f"imageDigest={digest}")
        log(f"  OK {name}: restore {row['desired_count']} task; {row['task_definition'].rsplit('/', 1)[-1]}")
    if not args.apply:
        log(f"Preflight passed. Would start {instance_id}, wait for EC2 checks, then restore all 10 services.")
        log("No AWS resources changed. Add --apply when you want staging running again.")
        return

    def wait_until(check, label, seconds):
        deadline = time.monotonic() + seconds
        while not check():
            require(time.monotonic() < deadline, f"Timed out waiting for {label}; inspect AWS, then rerun this command")
            log(f"Waiting for {label}...")
            time.sleep(15)

    if db["State"]["Name"] == "stopped":
        log(f"Starting database {instance_id}...")
        aws("ec2", "start-instances", "--instance-ids", instance_id)
    wait_until(lambda: instance()["State"]["Name"] == "running", "database running", 600)

    def database_checks_ok():
        rows = aws("ec2", "describe-instance-status", "--instance-ids", instance_id)["InstanceStatuses"]
        return bool(rows) and all(rows[0].get(k, {}).get("Status") == "ok" for k in ("InstanceStatus", "SystemStatus"))

    wait_until(database_checks_ok, "database EC2 status checks", 900)
    for group in groups:
        # Recheck each phase so an overlapping deployment stops the resume.
        current = services(group)
        for name in group:
            if current[name]["desiredCount"] == 0:
                aws("ecs", "update-service", "--cluster", cluster, "--service", name,
                    "--desired-count", str(saved[name]["desired_count"]))
                log(f"Started {name}")

        def stable():
            rows = services(group)
            for name, row in rows.items():
                require(row["desiredCount"] == saved[name]["desired_count"], f"Desired count changed during resume: {name}")
                require(all(d.get("rolloutState") != "FAILED" for d in row["deployments"]), f"Deployment failed: {name}")
            settled = all(r["runningCount"] == r["desiredCount"] and r["pendingCount"] == 0 and
                          len(r["deployments"]) == 1 and
                          r["deployments"][0].get("rolloutState", "COMPLETED") == "COMPLETED" for r in rows.values())
            if not settled:
                return False
            # A scaled-up task may be RUNNING before its dependency is ready.
            # Wait for configured container checks before starting the next phase.
            for name in group:
                if name not in health_checked:
                    continue
                task_ids = aws("ecs", "list-tasks", "--cluster", cluster, "--service-name", name,
                               "--desired-status", "RUNNING")["taskArns"]
                if len(task_ids) != saved[name]["desired_count"]:
                    return False
                tasks = aws("ecs", "describe-tasks", "--cluster", cluster, "--tasks", *task_ids)
                if tasks.get("failures") or len(tasks["tasks"]) != len(task_ids):
                    return False
                if any(t.get("healthStatus") != "HEALTHY" or t["taskDefinitionArn"] != saved[name]["task_definition"]
                       for t in tasks["tasks"]):
                    return False
            return True

        wait_until(stable, ", ".join(group), 1500)
    for url in record["health_urls"]:
        def healthy():
            result = subprocess.run(["curl", "--silent", "--show-error", "--max-time", "20", "--output", "/dev/null",
                                     "--write-out", "%{http_code}", url], capture_output=True, text=True, timeout=30)
            return result.returncode == 0 and result.stdout == "200"
        wait_until(healthy, url, 300)
        log(f"HTTP 200: {url}")
    log("Staging restored: database running, all 10 services stable, API/web/ops health checks passed.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print(f"STOPPED: {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("Interrupted. Completed AWS changes remain; inspect state before retrying.", file=sys.stderr)
        sys.exit(130)
