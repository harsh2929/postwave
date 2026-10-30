import { Resource } from "./_base.js";
import type {
  Form,
  FormCreateInput,
  FormListItem,
  FormUpdateInput,
  Submission,
} from "../types.js";

export class FormsResource extends Resource {
  list(): Promise<FormListItem[]> {
    return this.client.request("GET", "/api/v1/forms");
  }

  get(id: string): Promise<Form> {
    return this.client.request("GET", `/api/v1/forms/${encodeURIComponent(id)}`);
  }

  create(input: FormCreateInput): Promise<Form> {
    return this.client.request("POST", "/api/v1/forms", { body: input });
  }

  update(id: string, patch: FormUpdateInput): Promise<Form> {
    return this.client.request("PATCH", `/api/v1/forms/${encodeURIComponent(id)}`, { body: patch });
  }

  delete(id: string): Promise<{ ok: boolean }> {
    return this.client.request("DELETE", `/api/v1/forms/${encodeURIComponent(id)}`);
  }

  listSubmissions(id: string): Promise<Submission[]> {
    return this.client.request("GET", `/api/v1/forms/${encodeURIComponent(id)}/submissions`);
  }

  /** Programmatically confirm a pending double-opt-in submission via its token. */
  confirmOptIn(token: string): Promise<{ ok: boolean; subscriber_email?: string }> {
    return this.client.request(
      "POST",
      `/api/public/forms/confirm/${encodeURIComponent(token)}`,
    );
  }

  /** Returns the raw CSV body. */
  exportSubmissionsCSV(id: string): Promise<string> {
    return this.client.request("GET", `/api/v1/forms/${encodeURIComponent(id)}/submissions.csv`, {
      asText: true,
      headers: { Accept: "text/csv" },
    });
  }
}
