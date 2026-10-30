// SPDX-License-Identifier: AGPL-3.0-only
//
// infra/aws is applied by runbook and has no test runner, so nothing had ever
// read it. Auditing it found ZERO defects — which is exactly when these
// invariants are worth pinning, because writing them costs nothing today and
// would be a bug report tomorrow.
//
// Four properties, each chosen because breaking it is a one-line change that
// reviews cleanly:
//
//   1. Every CloudWatch alarm has an action. An alarm with none is a resource
//      that costs money, evaluates correctly, and tells nobody. That exact gap
//      existed in infra/backup, where BaseBackupHealthy and LogicalBackupHealthy
//      were published and alarmed on by no one.
//   2. Every alarm declares TreatMissingData. The default is `missing`, which
//      keeps an alarm in INSUFFICIENT_DATA rather than raising — so a metric
//      that stops arriving (the pipeline died) never fires.
//   3. Only 80/443 are reachable from the internet. Widening a security group
//      to a database or admin port is one line that reads like the two above it.
//   4. No secret VALUE sits in a task definition's `environment`. ECS has a
//      separate `secrets` block resolved from Secrets Manager; the API task
//      already puts 23 there, and `environment` is world-readable to anyone
//      with DescribeTaskDefinition.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const AWS_DIR = resolve(process.cwd(), "../../infra/aws");

/**
 * CloudFormation shorthand (`!Ref`, `!Sub`, …) is not plain YAML. The `yaml`
 * package surfaces them as unresolved tags; replacing them with a placeholder
 * before parsing keeps the document readable without pulling in a CFN library.
 */
function loadCfn(path: string): Record<string, unknown> | null {
  try {
    const text = readFileSync(path, "utf8").replace(
      /!(Ref|Sub|GetAtt|Equals|If|Not|Select|Split|Join|FindInMap|ImportValue|Condition|Base64|And|Or|Cidr)\b/g,
      "",
    );
    return parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function yamlFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(AWS_DIR)) {
    const abs = join(AWS_DIR, entry);
    if (entry.endsWith(".yaml") || entry.endsWith(".yml")) out.push(abs);
  }
  const cfn = join(AWS_DIR, "cloudformation");
  if (existsSync(cfn)) {
    for (const entry of readdirSync(cfn)) {
      if (entry.endsWith(".yaml")) out.push(join(cfn, entry));
    }
  }
  return out;
}

interface Resource {
  Type?: string;
  Properties?: Record<string, unknown>;
}

function resourcesOfType(type: string): Array<{ file: string; name: string; props: Record<string, unknown> }> {
  const found: Array<{ file: string; name: string; props: Record<string, unknown> }> = [];
  for (const file of yamlFiles()) {
    const doc = loadCfn(file);
    const resources = (doc?.Resources ?? {}) as Record<string, Resource>;
    for (const [name, res] of Object.entries(resources)) {
      if (res?.Type === type) {
        found.push({ file: file.split("/").slice(-2).join("/"), name, props: res.Properties ?? {} });
      }
    }
  }
  return found;
}

describe("AWS infrastructure invariants", () => {
  const alarms = resourcesOfType("AWS::CloudWatch::Alarm");

  it("reads the CloudFormation templates", () => {
    // Guard the guard: a parse failure or a wrong directory yields empty lists,
    // and every sweep below passes over nothing.
    expect(yamlFiles().length).toBeGreaterThan(2);
    expect(alarms.length).toBeGreaterThan(10);
  });

  it("wires every alarm to an action", () => {
    const silent = alarms
      .filter((a) => {
        const actions = (a.props.AlarmActions ?? []) as unknown[];
        const ok = (a.props.OKActions ?? []) as unknown[];
        return actions.length === 0 && ok.length === 0;
      })
      .map((a) => `${a.file}::${a.name}`);
    expect(silent, "these alarms evaluate and notify nobody").toEqual([]);
  });

  it("makes every alarm decide what a missing metric means", () => {
    // The default is `missing`, which holds INSUFFICIENT_DATA instead of
    // alarming — so a pipeline that stops publishing never pages anyone.
    const undecided = alarms
      .filter((a) => a.props.TreatMissingData === undefined)
      .map((a) => `${a.file}::${a.name} (${String(a.props.MetricName)})`);
    expect(undecided, "a stopped metric would never alarm").toEqual([]);
  });

  it("exposes only 80 and 443 to the internet", () => {
    const WORLD = new Set(["0.0.0.0/0", "::/0"]);
    const PUBLIC = new Set([80, 443]);
    const exposed: string[] = [];

    const consider = (
      where: string,
      rule: Record<string, unknown>,
    ): void => {
      const cidr = (rule.CidrIp ?? rule.CidrIpv6) as string | undefined;
      if (!cidr || !WORLD.has(cidr)) return;
      const from = rule.FromPort as number | undefined;
      const to = rule.ToPort as number | undefined;
      if (from !== undefined && to !== undefined && PUBLIC.has(from) && PUBLIC.has(to)) return;
      exposed.push(`${where} ${String(rule.IpProtocol)} ${String(from)}-${String(to)} from ${cidr}`);
    };

    for (const g of resourcesOfType("AWS::EC2::SecurityGroup")) {
      for (const rule of (g.props.SecurityGroupIngress ?? []) as Record<string, unknown>[]) {
        consider(`${g.file}::${g.name}`, rule);
      }
    }
    for (const g of resourcesOfType("AWS::EC2::SecurityGroupIngress")) {
      consider(`${g.file}::${g.name}`, g.props);
    }
    expect(exposed, "only 80/443 may be world-reachable").toEqual([]);
  });

  it("keeps secret values out of task-definition environment blocks", () => {
    // ECS resolves `secrets` from Secrets Manager at start; `environment` is
    // plain text readable by anyone who can DescribeTaskDefinition.
    const CREDENTIAL_SHAPED =
      /(sk_live_[A-Za-z0-9]|pk_live_[A-Za-z0-9]|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-|ghp_[A-Za-z0-9]{20,})/;
    const leaks: string[] = [];
    for (const entry of readdirSync(AWS_DIR)) {
      if (!entry.endsWith("task-definition.json")) continue;
      const doc = JSON.parse(readFileSync(join(AWS_DIR, entry), "utf8")) as {
        containerDefinitions?: Array<{
          name?: string;
          environment?: Array<{ name: string; value: string }>;
        }>;
      };
      for (const container of doc.containerDefinitions ?? []) {
        for (const env of container.environment ?? []) {
          if (CREDENTIAL_SHAPED.test(env.value)) {
            leaks.push(`${entry}::${String(container.name)}::${env.name}`);
          }
        }
      }
    }
    expect(leaks, "a credential in a plaintext environment block").toEqual([]);
  });
});
