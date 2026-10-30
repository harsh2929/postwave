// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export interface SafetyCheckInput {
  subject: string;
  body_html: string;
  body_text?: string;
  intended_audience_count: number;
}

export interface SafetyFinding {
  code: string;
  severity: "low" | "medium" | "high" | "block";
  message: string;
  evidence?: string;
}

export interface SafetyCheckResponse {
  ok: boolean;
  blocking: boolean;
  findings: SafetyFinding[];
}

export class SafetyResource extends Resource {
  check(input: SafetyCheckInput): Promise<SafetyCheckResponse> {
    return this.client.request("POST", "/api/v1/safety/check", { body: input });
  }
}
