// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "./api";
import { requireCustomDomainOperation } from "./custom-domain-operational-availability";

export type CustomDomainPurpose = "forms" | "links" | "web" | "tracking";

export interface CustomDomainDnsRecord {
  type: string;
  name: string;
  value: string;
  verified: boolean;
  error?: string;
}

export interface CustomDomain {
  id: string;
  tenantId: string;
  domain: string;
  purpose: CustomDomainPurpose;
  verified: boolean;
  dns_records: CustomDomainDnsRecord[];
  createdAt: string;
  verifiedAt?: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const RECORD_TYPES = new Set(["CNAME", "TXT"]);
const MAX_DOMAINS = 500;
const MAX_RECORDS = 16;

export class CustomDomainContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomDomainContractError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomDomainContractError(`${label} was malformed.`);
  }
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  label: string,
  max: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    throw new CustomDomainContractError(`${label} was malformed.`);
  }
  return value;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const result = text(value, label, 64);
  if (!RFC3339_RE.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new CustomDomainContractError(`${label} was malformed.`);
  }
  return result;
}

export function parseCustomDomainList(
  value: unknown,
  expectedTenantId?: string,
): CustomDomain[] {
  if (!Array.isArray(value) || value.length > MAX_DOMAINS) {
    throw new CustomDomainContractError("Custom-domain registry was malformed.");
  }
  const ids = new Set<string>();
  const domains = new Set<string>();
  return value.map((candidate, index) => {
    const row = object(candidate, `Custom-domain row ${index + 1}`);
    const id = text(row.id, "Custom-domain identity", 128, ID_RE);
    const tenantId = text(row.tenantId, "Custom-domain tenant", 128, ID_RE);
    const domain = text(row.domain, "Custom-domain hostname", 253, HOST_RE);
    if (expectedTenantId && tenantId !== expectedTenantId) {
      throw new CustomDomainContractError(
        "Custom-domain registry crossed the requested workspace boundary.",
      );
    }
    if (ids.has(id) || domains.has(domain)) {
      throw new CustomDomainContractError(
        "Custom-domain registry contained duplicate ownership evidence.",
      );
    }
    ids.add(id);
    domains.add(domain);
    const purpose = row.purpose;
    if (
      purpose !== "forms" &&
      purpose !== "links" &&
      purpose !== "web" &&
      purpose !== "tracking"
    ) {
      throw new CustomDomainContractError("Custom-domain purpose was malformed.");
    }
    if (typeof row.verified !== "boolean") {
      throw new CustomDomainContractError("Custom-domain check state was malformed.");
    }
    if (!Array.isArray(row.dns_records) || row.dns_records.length > MAX_RECORDS) {
      throw new CustomDomainContractError("Custom-domain DNS evidence was malformed.");
    }
    const recordKeys = new Set<string>();
    const dnsRecords = row.dns_records.map((candidateRecord, recordIndex) => {
      const record = object(
        candidateRecord,
        `Custom-domain DNS record ${recordIndex + 1}`,
      );
      const type = text(record.type, "DNS record type", 16).toUpperCase();
      const name = text(record.name, "DNS record name", 280);
      const recordValue = text(record.value, "DNS record value", 2048);
      if (!RECORD_TYPES.has(type) || typeof record.verified !== "boolean") {
        throw new CustomDomainContractError("Custom-domain DNS evidence was malformed.");
      }
      const key = `${type}:${name}`;
      if (recordKeys.has(key)) {
        throw new CustomDomainContractError("Custom-domain DNS evidence was duplicated.");
      }
      recordKeys.add(key);
      const error = record.error;
      if (error !== undefined && error !== null && typeof error !== "string") {
        throw new CustomDomainContractError("DNS record error was malformed.");
      }
      if (
        typeof error === "string" &&
        (error.length > 512 || /[\u0000-\u001f\u007f]/.test(error))
      ) {
        throw new CustomDomainContractError("DNS record error was malformed.");
      }
      return {
        type,
        name,
        value: recordValue,
        verified: record.verified,
        ...(typeof error === "string" && error ? { error } : {}),
      };
    });
    if (
      row.verified &&
      (dnsRecords.length === 0 || dnsRecords.some((record) => !record.verified))
    ) {
      throw new CustomDomainContractError(
        "Custom-domain aggregate check state contradicted its DNS evidence.",
      );
    }
    const createdAt = optionalTimestamp(row.createdAt, "Custom-domain creation time");
    if (!createdAt) {
      throw new CustomDomainContractError("Custom-domain creation time was malformed.");
    }
    const verifiedAt = optionalTimestamp(
      row.verifiedAt,
      "Custom-domain verification time",
    );
    if (!row.verified && verifiedAt) {
      throw new CustomDomainContractError(
        "Custom-domain verification timestamp contradicted its state.",
      );
    }
    if (verifiedAt && Date.parse(verifiedAt) < Date.parse(createdAt)) {
      throw new CustomDomainContractError(
        "Custom-domain verification time preceded its creation time.",
      );
    }
    return {
      id,
      tenantId,
      domain,
      purpose,
      verified: row.verified,
      dns_records: dnsRecords,
      createdAt,
      ...(verifiedAt ? { verifiedAt } : {}),
    };
  });
}

export async function listCustomDomains(options: {
  signal?: AbortSignal;
  expectedTenantId?: string;
  /** Drop DNS targets/tokens from the list cache until an explicit review. */
  minimizeDNSEvidence?: boolean;
} = {}): Promise<CustomDomain[]> {
  const response = await api.get<unknown>("/api/v1/custom-domains", {
    signal: options.signal,
    requireOnline: true,
    maxAttempts: 1,
  });
  const domains = parseCustomDomainList(response, options.expectedTenantId);
  return options.minimizeDNSEvidence
    ? domains.map((domain) => ({ ...domain, dns_records: [] }))
    : domains;
}

export async function getCustomDomainEvidence(options: {
  id: string;
  expectedTenantId: string;
  signal?: AbortSignal;
}): Promise<CustomDomain> {
  if (!ID_RE.test(options.id)) {
    throw new CustomDomainContractError(
      "Custom-domain evidence identity was malformed.",
    );
  }
  const response = await api.get<unknown>(
    `/api/v1/custom-domains/${encodeURIComponent(options.id)}`,
    { signal: options.signal, requireOnline: true, maxAttempts: 1 },
  );
  const [domain] = parseCustomDomainList(
    [response],
    options.expectedTenantId,
  );
  if (!domain || domain.id !== options.id) {
    throw new CustomDomainContractError(
      "Custom-domain evidence identity did not match the requested row.",
    );
  }
  return domain;
}

export async function createCustomDomain(input: {
  domain: string;
  purpose: CustomDomainPurpose;
}): Promise<CustomDomain> {
  requireCustomDomainOperation("registration");
  return api.post<CustomDomain>("/api/v1/custom-domains", input);
}

export async function verifyCustomDomain(
  id: string,
): Promise<{ verified: boolean; records: CustomDomainDnsRecord[] }> {
  requireCustomDomainOperation("verification");
  return api.post<{ verified: boolean; records: CustomDomainDnsRecord[] }>(
    `/api/v1/custom-domains/${encodeURIComponent(id)}/verify`,
  );
}

export async function deleteCustomDomain(id: string): Promise<{ ok: true }> {
  requireCustomDomainOperation("removal");
  return api.delete<{ ok: true }>(
    `/api/v1/custom-domains/${encodeURIComponent(id)}`,
  );
}
