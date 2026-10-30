import { api } from "./api";

export interface PublicCheckoutResponse {
  url: string;
  sessionId?: string;
}

export function createPublicCheckout(input: {
  tier: string;
  customerEmail: string;
}): Promise<PublicCheckoutResponse> {
  return api.post<PublicCheckoutResponse>("/api/public/billing/checkout", input, {
    credentials: "omit",
  });
}
