// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

export const COMPLIANCE_FRAMEWORKS = [
  "hipaa",
  "soc2",
  "gdpr",
  "ccpa",
  "pci_dss",
  "iso27001",
  "can_spam",
  "casl",
] as const;

export type ComplianceFramework = (typeof COMPLIANCE_FRAMEWORKS)[number];
export type ComplianceStatus =
  | "attested"
  | "in_progress"
  | "revoked"
  | "unsupported";
export type ComplianceEventType =
  | "attested"
  | "revoked"
  | "renewed"
  | "amended";

export interface ComplianceFrameworkMeta {
  framework: ComplianceFramework;
  short: string;
  full: string;
  description: string;
  region: string;
  renewalCadenceMonths: number | null;
  referenceUrl: string;
  gates: readonly string[];
}

export const COMPLIANCE_FRAMEWORK_CATALOG: readonly ComplianceFrameworkMeta[] =
  [
    {
      framework: "hipaa",
      short: "HIPAA",
      full: "Health Insurance Portability and Accountability Act",
      description:
        "Not supported by Moosewave. No BAA is offered; do not use the service for PHI.",
      region: "US · Healthcare",
      renewalCadenceMonths: null,
      referenceUrl: "https://www.hhs.gov/hipaa/for-professionals/index.html",
      gates: [],
    },
    {
      framework: "soc2",
      short: "SOC 2",
      full: "SOC 2 Type II",
      description:
        "Independent auditor attestation across applicable Trust Services Criteria.",
      region: "Global · SaaS",
      renewalCadenceMonths: 12,
      referenceUrl:
        "https://www.aicpa-cima.com/resources/landing/system-and-organization-controls-soc-suite-of-services",
      gates: [
        "Auditor report covering the current period",
        "Logical access controls documented and tested",
        "Change-management evidence linked to deployments",
        "Vendor and subprocessor inventory current",
      ],
    },
    {
      framework: "gdpr",
      short: "GDPR",
      full: "General Data Protection Regulation",
      description: "EU and EEA personal-data governance attestation.",
      region: "EU / EEA",
      renewalCadenceMonths: null,
      referenceUrl: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
      gates: [
        "Data-processing terms reviewed with subprocessors",
        "Records of processing activities maintained",
        "Incident notification process documented",
        "Cross-border transfer mechanism reviewed",
      ],
    },
    {
      framework: "ccpa",
      short: "CCPA / CPRA",
      full: "California Consumer Privacy Act and CPRA amendments",
      description: "California consumer-data governance attestation.",
      region: "US · California",
      renewalCadenceMonths: 12,
      referenceUrl: "https://oag.ca.gov/privacy/ccpa",
      gates: [
        "Required privacy disclosures reviewed",
        "Opt-out mechanisms reviewed",
        "Consumer request process tested",
        "Staff handling personal information trained",
      ],
    },
    {
      framework: "pci_dss",
      short: "PCI DSS",
      full: "Payment Card Industry Data Security Standard",
      description: "Payment-card security attestation for the workspace scope.",
      region: "Global · Payments",
      renewalCadenceMonths: 12,
      referenceUrl: "https://www.pcisecuritystandards.org/",
      gates: [
        "Applicable assessment evidence on file",
        "Required scan evidence current",
        "Cardholder-data scope documented",
        "Encryption controls reviewed",
      ],
    },
    {
      framework: "iso27001",
      short: "ISO 27001",
      full: "ISO/IEC 27001 — Information security management systems",
      description: "Information-security management attestation.",
      region: "Global",
      renewalCadenceMonths: 36,
      referenceUrl: "https://www.iso.org/standard/27001",
      gates: [
        "Statement of Applicability on file",
        "Risk assessment and treatment plan current",
        "Internal audit evidence current",
        "Management review evidence on file",
      ],
    },
    {
      framework: "can_spam",
      short: "CAN-SPAM",
      full: "CAN-SPAM Act",
      description: "US commercial-email practice attestation.",
      region: "US · Email",
      renewalCadenceMonths: null,
      referenceUrl:
        "https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business",
      gates: [
        "Unsubscribe mechanism present",
        "Suppression handling reviewed",
        "Sender identification reviewed",
        "Message headers and subjects reviewed",
      ],
    },
    {
      framework: "casl",
      short: "CASL",
      full: "Canada's Anti-Spam Legislation",
      description: "Canadian commercial-message practice attestation.",
      region: "Canada · Email",
      renewalCadenceMonths: null,
      referenceUrl: "https://crtc.gc.ca/eng/internet/anti.htm",
      gates: [
        "Consent evidence retained",
        "Sender identification reviewed",
        "Unsubscribe handling reviewed",
        "Contact details reviewed",
      ],
    },
  ] as const;

const CATALOG = new Map(
  COMPLIANCE_FRAMEWORK_CATALOG.map((entry) => [entry.framework, entry]),
);
const FRAMEWORK_SET = new Set<string>(COMPLIANCE_FRAMEWORKS);
const STATUS_SET = new Set<string>([
  "attested",
  "in_progress",
  "revoked",
  "unsupported",
]);
const EVENT_TYPE_SET = new Set<string>([
  "attested",
  "revoked",
  "renewed",
  "amended",
]);
const SHA256_RE = /^[a-f0-9]{64}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const EVENT_CURSOR_RE = /^[A-Za-z0-9_-]+$/u;
const COMPLIANCE_EVENT_PAGE_LIMIT = 100;
const MAX_EVENT_METADATA_BYTES = 4 * 1024;
const MAX_EVENT_METADATA_PROPERTIES = 256;
const UTF8 = new TextEncoder();

function utf8Bytes(value: string): number {
  return UTF8.encode(value).byteLength;
}

export interface ComplianceProgram {
  framework: ComplianceFramework;
  status: ComplianceStatus;
  signedByEmail?: string;
  signerName?: string;
  documentPath?: string;
  documentSha256?: string;
  notes?: string;
  attestedAt?: string;
  renewalAt?: string;
  updatedAt?: string;
}

export interface ComplianceEvent {
  id: number;
  framework: ComplianceFramework;
  eventType: ComplianceEventType;
  signedByEmail?: string;
  counterSignedBy?: string;
  documentPath?: string;
  documentSha256?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  at: string;
}

export interface ComplianceEventsPage {
  events: ComplianceEvent[];
  hasMore: boolean;
  limit: 100;
  nextCursor: string | null;
}

export interface ComplianceAttestationInput {
  signedByEmail: string;
  signerName?: string;
  documentPath?: string;
  documentSha256?: string;
  notes?: string;
  renewalAt?: string;
  expectedUpdatedAt?: string;
}

export interface ComplianceMutationReceipt {
  ok: true;
  updatedAt: string;
  framework?: ComplianceFramework;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} response is malformed.`);
  }
  return value as Record<string, unknown>;
}

function boundedText(
  value: unknown,
  label: string,
  max: number,
  required = false,
): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${label} is missing.`);
    return undefined;
  }
  if (typeof value !== "string" || utf8Bytes(value) > max) {
    throw new Error(`${label} is malformed.`);
  }
  const trimmed = value.trim();
  if (!trimmed && required) throw new Error(`${label} is missing.`);
  return trimmed || undefined;
}

function timestamp(
  value: unknown,
  label: string,
  required = false,
): string | undefined {
  const parsed = boundedText(value, label, 64, required);
  if (!parsed) return undefined;
  if (!Number.isFinite(Date.parse(parsed)) || parsed.startsWith("0001-")) {
    throw new Error(`${label} is not a valid timestamp.`);
  }
  return parsed;
}

function framework(
  value: unknown,
  expected?: ComplianceFramework,
): ComplianceFramework {
  const parsed = boundedText(value, "Compliance framework", 32, true);
  if (!parsed || !FRAMEWORK_SET.has(parsed)) {
    throw new Error("Compliance framework is unsupported or malformed.");
  }
  if (expected && parsed !== expected) {
    throw new Error("Compliance response belongs to a different framework.");
  }
  return parsed as ComplianceFramework;
}

function optionalTextField(
  row: Record<string, unknown>,
  key: string,
  label: string,
  max: number,
): Record<string, string> {
  const value = boundedText(row[key], label, max);
  return value ? { [key]: value } : {};
}

function normalizeProgram(
  value: unknown,
  expected?: ComplianceFramework,
): ComplianceProgram {
  const row = record(value, "Compliance programme");
  const parsedFramework = framework(row.framework, expected);
  if (typeof row.status !== "string" || !STATUS_SET.has(row.status)) {
    throw new Error("Compliance programme status is malformed.");
  }
  const status = row.status as ComplianceStatus;
  if (parsedFramework === "hipaa" && status !== "unsupported") {
    throw new Error("HIPAA must remain an explicit unsupported programme.");
  }
  const signedByEmail = boundedText(row.signedByEmail, "Signer email", 320);
  if (signedByEmail && !EMAIL_RE.test(signedByEmail)) {
    throw new Error("Compliance signer email is malformed.");
  }
  const documentSha256 = boundedText(
    row.documentSha256,
    "Document SHA-256",
    64,
  )?.toLowerCase();
  if (documentSha256 && !SHA256_RE.test(documentSha256)) {
    throw new Error("Compliance document SHA-256 is malformed.");
  }
  const updatedAt = timestamp(row.updatedAt, "Programme revision");
  const attestedAt = timestamp(row.attestedAt, "Attestation timestamp");
  const renewalAt = timestamp(row.renewalAt, "Renewal timestamp");
  if ((status === "attested" || status === "revoked") && !updatedAt) {
    throw new Error("Stored compliance programme is missing its revision.");
  }
  if ((status === "attested" || status === "revoked") && !attestedAt) {
    throw new Error(
      "Stored compliance programme is missing its attestation timestamp.",
    );
  }
  return {
    framework: parsedFramework,
    status,
    ...(signedByEmail ? { signedByEmail } : {}),
    ...optionalTextField(row, "signerName", "Signer name", 200),
    ...optionalTextField(row, "documentPath", "Document path", 2048),
    ...(documentSha256 ? { documentSha256 } : {}),
    ...optionalTextField(row, "notes", "Programme notes", 4000),
    ...(attestedAt ? { attestedAt } : {}),
    ...(renewalAt ? { renewalAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function normalizeCompliancePrograms(
  value: unknown,
): ComplianceProgram[] {
  const body = record(value, "Compliance programmes");
  if (!Array.isArray(body.programs) || body.programs.length > 32) {
    throw new Error("Compliance programmes response is malformed.");
  }
  const seen = new Set<ComplianceFramework>();
  const programs = body.programs.map((item) => {
    const parsed = normalizeProgram(item);
    if (seen.has(parsed.framework)) {
      throw new Error(
        "Compliance programmes response contains a duplicate framework.",
      );
    }
    seen.add(parsed.framework);
    return parsed;
  });
  if (programs.length > 0 && !seen.has("hipaa")) {
    throw new Error(
      "Compliance programmes response omitted the HIPAA limitation.",
    );
  }
  return programs;
}

function normalizeEvent(
  value: unknown,
  expected: ComplianceFramework,
): ComplianceEvent {
  const row = record(value, "Compliance event");
  if (!Number.isSafeInteger(row.id) || (row.id as number) <= 0) {
    throw new Error("Compliance event id is malformed.");
  }
  if (typeof row.eventType !== "string" || !EVENT_TYPE_SET.has(row.eventType)) {
    throw new Error("Compliance event type is malformed.");
  }
  const eventFramework = framework(row.framework, expected);
  const documentSha256 = boundedText(
    row.documentSha256,
    "Event document SHA-256",
    64,
  )?.toLowerCase();
  if (documentSha256 && !SHA256_RE.test(documentSha256)) {
    throw new Error("Compliance event document SHA-256 is malformed.");
  }
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata !== undefined && row.metadata !== null) {
    metadata = record(row.metadata, "Compliance event metadata");
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(metadata);
    } catch {
      throw new Error("Compliance event metadata is malformed.");
    }
    if (
      encoded === undefined ||
      Object.keys(metadata).length > MAX_EVENT_METADATA_PROPERTIES ||
      utf8Bytes(encoded) > MAX_EVENT_METADATA_BYTES
    ) {
      throw new Error("Compliance event metadata exceeds its response bound.");
    }
  }
  const signedByEmail = boundedText(
    row.signedByEmail,
    "Event signer email",
    320,
  );
  if (signedByEmail && !EMAIL_RE.test(signedByEmail)) {
    throw new Error("Compliance event signer email is malformed.");
  }
  return {
    id: row.id as number,
    framework: eventFramework,
    eventType: row.eventType as ComplianceEventType,
    ...(signedByEmail ? { signedByEmail } : {}),
    ...optionalTextField(row, "counterSignedBy", "Event counter-signer", 200),
    ...optionalTextField(row, "documentPath", "Event document path", 2048),
    ...(documentSha256 ? { documentSha256 } : {}),
    ...optionalTextField(row, "notes", "Event notes", 4000),
    ...(metadata ? { metadata } : {}),
    at: timestamp(row.at, "Event timestamp", true) as string,
  };
}

export function normalizeComplianceEvents(
  value: unknown,
  expected: ComplianceFramework,
): ComplianceEventsPage {
  const body = record(value, "Compliance event ledger");
  if (
    !Array.isArray(body.events) ||
    body.events.length > COMPLIANCE_EVENT_PAGE_LIMIT
  ) {
    throw new Error("Compliance event ledger exceeds its 100-row contract.");
  }
  if (typeof body.hasMore !== "boolean") {
    throw new Error("Compliance event ledger continuation state is malformed.");
  }
  if (body.limit !== COMPLIANCE_EVENT_PAGE_LIMIT) {
    throw new Error("Compliance event ledger limit is malformed.");
  }
  let nextCursor: string | null = null;
  if (body.nextCursor !== null) {
    if (
      typeof body.nextCursor !== "string" ||
      body.nextCursor.length === 0 ||
      body.nextCursor.length > 512 ||
      body.nextCursor.trim() !== body.nextCursor ||
      !EVENT_CURSOR_RE.test(body.nextCursor)
    ) {
      throw new Error("Compliance event ledger cursor is malformed.");
    }
    nextCursor = body.nextCursor;
  }
  if (body.hasMore !== (nextCursor !== null)) {
    throw new Error("Compliance event ledger continuation is inconsistent.");
  }
  if (body.hasMore && body.events.length !== COMPLIANCE_EVENT_PAGE_LIMIT) {
    throw new Error("Compliance event ledger continuation page is incomplete.");
  }
  if (body.framework !== undefined) framework(body.framework, expected);
  const seen = new Set<number>();
  const events = body.events.map((item) => {
    const event = normalizeEvent(item, expected);
    if (seen.has(event.id)) {
      throw new Error("Compliance event ledger contains a duplicate event.");
    }
    seen.add(event.id);
    return event;
  });
  return {
    events,
    hasMore: body.hasMore,
    limit: COMPLIANCE_EVENT_PAGE_LIMIT,
    nextCursor,
  };
}

export function complianceFrameworkMeta(
  value: ComplianceFramework,
): ComplianceFrameworkMeta {
  const entry = CATALOG.get(value);
  if (!entry) throw new Error("Compliance framework metadata is unavailable.");
  return entry;
}

export async function listCompliancePrograms(
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<ComplianceProgram[]> {
  const response = await api.get<unknown>("/api/v1/compliance/programs", {
    signal: options.signal,
    ...(options.fresh ? { requireOnline: true, maxAttempts: 1 } : {}),
  });
  return normalizeCompliancePrograms(response);
}

export async function getComplianceProgram(
  selected: ComplianceFramework,
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<ComplianceProgram> {
  const response = await api.get<unknown>(
    `/api/v1/compliance/programs/${encodeURIComponent(selected)}`,
    {
      signal: options.signal,
      ...(options.fresh ? { requireOnline: true, maxAttempts: 1 } : {}),
    },
  );
  return normalizeProgram(response, selected);
}

export async function listComplianceEvents(
  selected: ComplianceFramework,
  options: { signal?: AbortSignal; fresh?: boolean; cursor?: string } = {},
): Promise<ComplianceEventsPage> {
  let cursor = "";
  if (options.cursor !== undefined) {
    cursor = options.cursor;
    if (
      cursor.length === 0 ||
      cursor.length > 512 ||
      cursor.trim() !== cursor ||
      !EVENT_CURSOR_RE.test(cursor)
    ) {
      throw new Error("Compliance event cursor is malformed.");
    }
  }
  const response = await api.get<unknown>(
    `/api/v1/compliance/programs/${encodeURIComponent(selected)}/events${
      cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
    }`,
    {
      signal: options.signal,
      ...(options.fresh ? { requireOnline: true, maxAttempts: 1 } : {}),
    },
  );
  return normalizeComplianceEvents(response, selected);
}

function canonicalAttestationInput(
  input: ComplianceAttestationInput,
): ComplianceAttestationInput {
  const signedByEmail = input.signedByEmail.trim();
  const signerName = input.signerName?.trim() || undefined;
  const documentPath = input.documentPath?.trim() || undefined;
  const documentSha256 =
    input.documentSha256?.trim().toLowerCase() || undefined;
  const notes = input.notes?.trim() || undefined;
  if (!EMAIL_RE.test(signedByEmail) || utf8Bytes(signedByEmail) > 320) {
    throw new Error("Enter one valid signer email address.");
  }
  if (
    signerName &&
    (utf8Bytes(signerName) > 200 || /[\r\n]/u.test(signerName))
  ) {
    throw new Error(
      "Counter-signer must be at most 200 UTF-8 bytes with no line breaks.",
    );
  }
  if (
    documentPath &&
    (utf8Bytes(documentPath) > 2048 || /[\u0000\r\n]/u.test(documentPath))
  ) {
    throw new Error(
      "Evidence path must be at most 2,048 UTF-8 bytes with no line breaks.",
    );
  }
  if (documentSha256 && !SHA256_RE.test(documentSha256)) {
    throw new Error(
      "Document SHA-256 must be exactly 64 hexadecimal characters.",
    );
  }
  if (notes && (utf8Bytes(notes) > 4000 || notes.includes("\u0000"))) {
    throw new Error("Notes must be at most 4,000 UTF-8 bytes.");
  }
  const renewalAt = input.renewalAt
    ? timestamp(input.renewalAt, "Renewal date", true)
    : undefined;
  const expectedUpdatedAt = input.expectedUpdatedAt
    ? timestamp(input.expectedUpdatedAt, "Programme revision", true)
    : undefined;
  return {
    signedByEmail,
    ...(signerName ? { signerName } : {}),
    ...(documentPath ? { documentPath } : {}),
    ...(documentSha256 ? { documentSha256 } : {}),
    ...(notes ? { notes } : {}),
    ...(renewalAt ? { renewalAt } : {}),
    ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
  };
}

function normalizeMutationReceipt(
  value: unknown,
  expected: ComplianceFramework,
  includeFramework: boolean,
): ComplianceMutationReceipt {
  const body = record(value, "Compliance mutation receipt");
  if (body.ok !== true) {
    throw new Error("Compliance mutation was not acknowledged.");
  }
  const updatedAt = timestamp(
    body.updatedAt,
    "Compliance mutation revision",
    true,
  ) as string;
  if (includeFramework) framework(body.framework, expected);
  return {
    ok: true,
    updatedAt,
    ...(includeFramework ? { framework: expected } : {}),
  };
}

export async function attestComplianceProgram(
  selected: Exclude<ComplianceFramework, "hipaa">,
  input: ComplianceAttestationInput,
): Promise<ComplianceMutationReceipt> {
  const response = await api.post<unknown>(
    `/api/v1/compliance/programs/${encodeURIComponent(selected)}/attest`,
    canonicalAttestationInput(input),
    { requireOnline: true, maxAttempts: 1 },
  );
  return normalizeMutationReceipt(response, selected, true);
}

export async function revokeComplianceProgram(
  selected: Exclude<ComplianceFramework, "hipaa">,
  input: { reason?: string; expectedUpdatedAt: string },
): Promise<ComplianceMutationReceipt> {
  const reason = input.reason?.trim() || "";
  if (utf8Bytes(reason) > 2000 || reason.includes("\u0000")) {
    throw new Error("Revocation reason must be at most 2,000 UTF-8 bytes.");
  }
  const expectedUpdatedAt = timestamp(
    input.expectedUpdatedAt,
    "Programme revision",
    true,
  ) as string;
  const response = await api.post<unknown>(
    `/api/v1/compliance/programs/${encodeURIComponent(selected)}/revoke`,
    { reason, expectedUpdatedAt },
    { requireOnline: true, maxAttempts: 1 },
  );
  return normalizeMutationReceipt(response, selected, false);
}

export function unsupportedPrograms(
  programs: readonly ComplianceProgram[],
): ComplianceProgram[] {
  return programs.filter((program) => program.status === "unsupported");
}

export function noneAttested(programs: readonly ComplianceProgram[]): boolean {
  return (
    programs.length > 0 &&
    programs.every((program) => program.status !== "attested")
  );
}
