import { Resource } from "./_base.js";
import type {
  CampaignReport,
  Diagnosis,
  PredictInput,
  PredictResponse,
  RenderInput,
  RenderResponse,
} from "../types.js";

export class InboxRealityResource extends Resource {
  getCampaignReport(campaignId: string): Promise<CampaignReport> {
    return this.client.request(
      "GET",
      `/api/v1/inbox-reality/campaigns/${encodeURIComponent(campaignId)}`,
    );
  }

  predict(input: PredictInput): Promise<PredictResponse> {
    return this.client.request("POST", "/api/v1/predict", { body: input });
  }

  diagnose(campaignId: string, signals?: Record<string, unknown>): Promise<Diagnosis> {
    return this.client.request("POST", `/api/v1/diagnose/${encodeURIComponent(campaignId)}`, {
      body: signals ?? {},
    });
  }

  render(input: RenderInput): Promise<RenderResponse> {
    return this.client.request("POST", "/api/v1/render", { body: input });
  }
}
