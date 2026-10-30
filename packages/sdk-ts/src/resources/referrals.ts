import { Resource } from "./_base.js";

export interface ReferralMilestone {
  count: number;
  reward_label: string;
}

export interface ReferralProgram {
  id: string;
  tenantId: string;
  milestones: ReferralMilestone[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReferralSubscriberView {
  share_url: string;
  ref_code: string;
  referrals_count: number;
  milestones_unlocked: ReferralMilestone[];
}

export class ReferralsResource extends Resource {
  /**
   * @deprecated The server keeps referral-program mutations release-gated.
   * This compatibility method remains for source stability and will return
   * the server's unavailable-route response until the complete attribution
   * and reward runtime is qualified.
   */
  setProgram(milestones: ReferralMilestone[]): Promise<ReferralProgram> {
    return this.client.request("POST", "/api/v1/referral-programs", {
      body: { milestones },
    });
  }

  getProgram(): Promise<ReferralProgram> {
    return this.client.request("GET", "/api/v1/referral-programs/current");
  }

  /**
   * @deprecated Subscriber referral-link issuance is release-gated because
   * the legacy GET can mint a live attribution token.
   */
  subscriberView(subscriberId: string): Promise<ReferralSubscriberView> {
    return this.client.request(
      "GET",
      `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/referral`,
    );
  }
}
