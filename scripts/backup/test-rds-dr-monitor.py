#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only

"""Regression tests for the inline recovery-Region RDS monitor Lambda."""

import datetime
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "infra" / "backup" / "aws-rds-dr.yaml"
SOURCE_ARN = "arn:aws:rds:us-west-2:123456789012:db:postwave-prod"
REPLICA_KEY = (
    "arn:aws:kms:us-east-1:123456789012:"
    "key/11111111-1111-1111-1111-111111111111"
)
REPLICA_VAULT_NAME = "postwave-prod-rds-replica"
REPLICA_VAULT_ARN = (
    "arn:aws:backup:us-east-1:123456789012:"
    f"backup-vault:{REPLICA_VAULT_NAME}"
)


def inline_lambda_source():
    lines = TEMPLATE.read_text(encoding="utf-8").splitlines()
    start = lines.index("        ZipFile: |") + 1
    end = lines.index("  NativeReplicationMonitorSchedule:")
    return "\n".join(
        line[10:] if line.startswith("          ") else line
        for line in lines[start:end]
    )


class Paginator:
    def __init__(self, expected_kwargs, pages):
        self.expected_kwargs = expected_kwargs
        self.pages = pages

    def paginate(self, **kwargs):
        if kwargs != self.expected_kwargs:
            raise AssertionError(
                f"unexpected paginator arguments: {kwargs!r} != "
                f"{self.expected_kwargs!r}"
            )
        return iter(self.pages)


class RdsClient:
    def __init__(self, record):
        self.record = record

    def get_paginator(self, name):
        if name != "describe_db_instance_automated_backups":
            raise AssertionError(name)
        # The recovery Region has no source DB instance. The monitor must list
        # all automated backups and bind the match to the source ARN itself.
        return Paginator({}, [{"DBInstanceAutomatedBackups": [self.record]}])


class BackupClient:
    def __init__(self, recovery_point):
        self.recovery_point = recovery_point

    def get_paginator(self, name):
        if name != "list_recovery_points_by_backup_vault":
            raise AssertionError(name)
        return Paginator(
            {
                "BackupVaultName": REPLICA_VAULT_NAME,
                "ByResourceArn": SOURCE_ARN,
                "ByResourceType": "RDS",
            },
            [{"RecoveryPoints": [self.recovery_point]}],
        )

    def describe_backup_vault(self, **kwargs):
        if kwargs != {"BackupVaultName": REPLICA_VAULT_NAME}:
            raise AssertionError(kwargs)
        return {
            "BackupVaultArn": REPLICA_VAULT_ARN,
            "EncryptionKeyArn": REPLICA_KEY,
            "VaultType": "BACKUP_VAULT",
            "VaultState": "AVAILABLE",
            "Locked": True,
            "MinRetentionDays": 35,
            "MaxRetentionDays": 365,
            "LockDate": datetime.datetime.now(datetime.timezone.utc),
        }


class KmsClient:
    def describe_key(self, **kwargs):
        if kwargs != {"KeyId": REPLICA_KEY}:
            raise AssertionError(kwargs)
        return {
            "KeyMetadata": {
                "Arn": REPLICA_KEY,
                "Enabled": True,
                "KeyState": "Enabled",
                "KeyManager": "CUSTOMER",
                "KeyUsage": "ENCRYPT_DECRYPT",
            }
        }


class CloudWatchClient:
    def __init__(self):
        self.metric_data = []

    def put_metric_data(self, **kwargs):
        if kwargs.get("Namespace") != "Postwave/Backup":
            raise AssertionError(kwargs)
        self.metric_data.extend(kwargs["MetricData"])


class RdsDrMonitorTests(unittest.TestCase):
    def run_monitor(
        self,
        *,
        point_kms=REPLICA_KEY,
        source_vault=(
            "arn:aws:backup:us-west-2:123456789012:"
            "backup-vault:postwave-prod-rds-primary"
        ),
    ):
        now = datetime.datetime.now(datetime.timezone.utc)
        record = {
            "DBInstanceArn": SOURCE_ARN,
            "Status": "active",
            "Engine": "postgres",
            "Encrypted": True,
            "KmsKeyId": REPLICA_KEY,
            "BackupRetentionPeriod": 14,
            "RestoreWindow": {"LatestTime": now - datetime.timedelta(minutes=5)},
        }
        recovery_point = {
            "BackupVaultArn": REPLICA_VAULT_ARN,
            "ResourceArn": SOURCE_ARN,
            "ResourceType": "RDS",
            "Status": "COMPLETED",
            "VaultType": "BACKUP_VAULT",
            "IsEncrypted": True,
            "EncryptionKeyArn": point_kms,
            "EncryptionKeyType": "CUSTOMER_MANAGED_KMS_KEY",
            "SourceBackupVaultArn": source_vault,
            "Lifecycle": {"DeleteAfterDays": 35},
            "CompletionDate": now - datetime.timedelta(hours=1),
        }
        clients = {
            "rds": RdsClient(record),
            "backup": BackupClient(recovery_point),
            "kms": KmsClient(),
            "cloudwatch": CloudWatchClient(),
        }
        boto3 = types.ModuleType("boto3")
        boto3.client = lambda service: clients[service]
        namespace = {}
        environment = {
            "SOURCE_DB_ARN": SOURCE_ARN,
            "EXPECTED_KMS_KEY_ARN": REPLICA_KEY,
            "EXPECTED_RETENTION_DAYS": "14",
            "EXPECTED_SNAPSHOT_RETENTION_DAYS": "35",
            "REPLICA_BACKUP_VAULT_ARN": REPLICA_VAULT_ARN,
            "REPLICA_BACKUP_VAULT_NAME": REPLICA_VAULT_NAME,
            "ENVIRONMENT": "prod",
        }
        with mock.patch.dict(os.environ, environment, clear=True), mock.patch.dict(
            sys.modules, {"boto3": boto3}
        ):
            exec(compile(inline_lambda_source(), str(TEMPLATE), "exec"), namespace)
            error = None
            result = None
            try:
                result = namespace["handler"]({}, None)
            except RuntimeError as exc:
                error = exc
        metrics = {
            item["MetricName"]: item["Value"]
            for item in clients["cloudwatch"].metric_data
        }
        return result, error, metrics

    def test_valid_native_and_snapshot_recovery_paths(self):
        result, error, metrics = self.run_monitor()
        self.assertIsNone(error)
        self.assertTrue(result["valid"])
        self.assertEqual(metrics["NativeRdsReplicationValid"], 1)
        self.assertEqual(metrics["RdsBackupReplicaValid"], 1)
        self.assertLess(metrics["NativeRdsReplicationLagSeconds"], 600)
        self.assertLess(metrics["RdsBackupReplicaAgeSeconds"], 4000)

    def test_wrong_snapshot_key_fails_closed_after_emitting_metrics(self):
        result, error, metrics = self.run_monitor(
            point_kms=(
                "arn:aws:kms:us-east-1:123456789012:"
                "key/22222222-2222-2222-2222-222222222222"
            )
        )
        self.assertIsNone(result)
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(metrics["NativeRdsReplicationValid"], 1)
        self.assertEqual(metrics["RdsBackupReplicaValid"], 0)

    def test_wrong_source_vault_fails_closed_after_emitting_metrics(self):
        result, error, metrics = self.run_monitor(
            source_vault=(
                "arn:aws:backup:us-west-2:123456789012:"
                "backup-vault:another-rds-primary"
            )
        )
        self.assertIsNone(result)
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(metrics["NativeRdsReplicationValid"], 1)
        self.assertEqual(metrics["RdsBackupReplicaValid"], 0)


if __name__ == "__main__":
    unittest.main()
