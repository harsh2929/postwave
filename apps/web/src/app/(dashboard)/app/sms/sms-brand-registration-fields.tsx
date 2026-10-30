// SPDX-License-Identifier: AGPL-3.0-only

import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { SmsSenderProfile } from "@/lib/sms-api";
import type { SmsBrandRegistrationDraft } from "./sms-registration-drafts";

interface SmsBrandRegistrationFieldsProps {
  brandRegistration: SmsBrandRegistrationDraft;
  pending: string | null;
  registrationProvider: SmsSenderProfile["provider"];
  setBrandRegistration: Dispatch<SetStateAction<SmsBrandRegistrationDraft>>;
  onSubmitBrand: () => void | Promise<void>;
}

export function SmsBrandRegistrationFields({
  brandRegistration,
  pending,
  registrationProvider,
  setBrandRegistration,
  onSubmitBrand,
}: SmsBrandRegistrationFieldsProps) {
  return registrationProvider === "twilio" ? (
    <TwilioBrandFields
      brandRegistration={brandRegistration}
      pending={pending}
      setBrandRegistration={setBrandRegistration}
      onSubmitBrand={onSubmitBrand}
    />
  ) : (
    <CarrierBrandFields
      brandRegistration={brandRegistration}
      pending={pending}
      setBrandRegistration={setBrandRegistration}
      onSubmitBrand={onSubmitBrand}
    />
  );
}

function TwilioBrandFields({
  brandRegistration,
  pending,
  setBrandRegistration,
  onSubmitBrand,
}: {
  brandRegistration: SmsBrandRegistrationDraft;
  pending: string | null;
  setBrandRegistration: Dispatch<SetStateAction<SmsBrandRegistrationDraft>>;
  onSubmitBrand: () => void | Promise<void>;
}) {
  return (
    <div className="grid gap-3">
      <div className="space-y-2">
        <Label htmlFor="customer_profile_bundle_sid">
          Customer Profile Bundle SID
        </Label>
        <Input
          id="customer_profile_bundle_sid"
          placeholder="BU..."
          value={brandRegistration.customer_profile_bundle_sid}
          onChange={(e) =>
            setBrandRegistration((current) => ({
              ...current,
              customer_profile_bundle_sid: e.target.value,
            }))
          }
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="a2p_profile_bundle_sid">A2P Profile Bundle SID</Label>
        <Input
          id="a2p_profile_bundle_sid"
          placeholder="BU..."
          value={brandRegistration.a2p_profile_bundle_sid}
          onChange={(e) =>
            setBrandRegistration((current) => ({
              ...current,
              a2p_profile_bundle_sid: e.target.value,
            }))
          }
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="brand_type">Brand type</Label>
        <Select
          id="brand_type"
          value={brandRegistration.brand_type}
          onChange={(e) =>
            setBrandRegistration((current) => ({
              ...current,
              brand_type: e.target.value,
            }))
          }
        >
          <option value="STANDARD">Standard</option>
          <option value="SOLE_PROPRIETOR">Sole proprietor</option>
        </Select>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={() => void onSubmitBrand()}
        disabled={pending === "brand-registration"}
      >
        Submit Brand
      </Button>
    </div>
  );
}

function CarrierBrandFields({
  brandRegistration,
  pending,
  setBrandRegistration,
  onSubmitBrand,
}: {
  brandRegistration: SmsBrandRegistrationDraft;
  pending: string | null;
  setBrandRegistration: Dispatch<SetStateAction<SmsBrandRegistrationDraft>>;
  onSubmitBrand: () => void | Promise<void>;
}) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <BrandTextInput
          id="carrier_company_name"
          label="Company name"
          value={brandRegistration.company_name}
          field="company_name"
          setBrandRegistration={setBrandRegistration}
        />
        <BrandTextInput
          id="carrier_display_name"
          label="Display name"
          value={brandRegistration.display_name}
          field="display_name"
          setBrandRegistration={setBrandRegistration}
        />
        <BrandTextInput
          id="carrier_ein"
          label="EIN / business ID"
          value={brandRegistration.ein}
          field="ein"
          setBrandRegistration={setBrandRegistration}
        />
        <BrandTextInput
          id="carrier_vertical"
          label="Vertical"
          value={brandRegistration.vertical}
          field="vertical"
          setBrandRegistration={setBrandRegistration}
        />
        <BrandTextInput
          id="carrier_email"
          label="Contact email"
          type="email"
          value={brandRegistration.email}
          field="email"
          setBrandRegistration={setBrandRegistration}
        />
        <BrandTextInput
          id="carrier_phone"
          label="Contact phone"
          value={brandRegistration.phone}
          field="phone"
          setBrandRegistration={setBrandRegistration}
        />
        <BrandTextInput
          id="carrier_website"
          label="Website"
          value={brandRegistration.website}
          field="website"
          setBrandRegistration={setBrandRegistration}
        />
        <BrandTextInput
          id="carrier_state"
          label="State"
          value={brandRegistration.state}
          field="state"
          setBrandRegistration={setBrandRegistration}
        />
      </div>
      <BrandTextInput
        id="carrier_street"
        label="Street address"
        value={brandRegistration.street}
        field="street"
        setBrandRegistration={setBrandRegistration}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <BrandTextInput
          id="carrier_city"
          label="City"
          value={brandRegistration.city}
          field="city"
          setBrandRegistration={setBrandRegistration}
        />
        <BrandTextInput
          id="carrier_postal_code"
          label="Postal code"
          value={brandRegistration.postal_code}
          field="postal_code"
          setBrandRegistration={setBrandRegistration}
        />
        <BrandTextInput
          id="carrier_country"
          label="Country"
          value={brandRegistration.country}
          field="country"
          setBrandRegistration={setBrandRegistration}
        />
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={() => void onSubmitBrand()}
        disabled={pending === "brand-registration"}
      >
        Submit Brand
      </Button>
    </div>
  );
}

function BrandTextInput({
  field,
  id,
  label,
  setBrandRegistration,
  type = "text",
  value,
}: {
  field: keyof SmsBrandRegistrationDraft;
  id: string;
  label: string;
  setBrandRegistration: Dispatch<SetStateAction<SmsBrandRegistrationDraft>>;
  type?: string;
  value: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) =>
          setBrandRegistration((current) => ({
            ...current,
            [field]: e.target.value,
          }))
        }
      />
    </div>
  );
}
