import { Resource } from "./_base.js";

export type CustomDomainPurpose = "forms" | "links" | "web";

export interface DNSRecord {
  type: string;
  name: string;
  value: string;
}

export interface CustomDomain {
  id: string;
  tenantId: string;
  domain: string;
  purpose: CustomDomainPurpose;
  verified: boolean;
  dns_records: DNSRecord[];
  createdAt: string;
  verifiedAt?: string | null;
}

export interface CreateCustomDomainInput {
  domain: string;
  purpose: CustomDomainPurpose;
}

export class CustomDomainsResource extends Resource {
  list(): Promise<CustomDomain[]> {
    return this.client.request("GET", "/api/v1/custom-domains");
  }

  create(input: CreateCustomDomainInput): Promise<CustomDomain> {
    return this.client.request("POST", "/api/v1/custom-domains", { body: input });
  }

  verify(id: string): Promise<{ verified: boolean }> {
    return this.client.request("POST", `/api/v1/custom-domains/${encodeURIComponent(id)}/verify`);
  }

  delete(id: string): Promise<{ ok: boolean }> {
    return this.client.request("DELETE", `/api/v1/custom-domains/${encodeURIComponent(id)}`);
  }
}
