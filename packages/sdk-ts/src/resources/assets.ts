// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export interface Asset {
  id: string;
  tenantId: string;
  filename: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  url: string;
  createdAt: string;
  altText: string;
  referencesCount: number;
  lastUsedAt?: string;
  folderId: string | null;
}

export interface AssetCounts {
  all: number;
  recent: number;
  inUse: number;
  unused: number;
  large: number;
}

export interface AssetReferrer {
  kind: "campaign" | "template" | "form";
  id: string;
  name: string;
}

export interface AssetListPage {
  items: Asset[];
  counts: AssetCounts;
  nextCursor: string | null;
}

export interface AssetDetail {
  asset: Asset;
  usage: AssetReferrer[];
}

export interface AssetUsage {
  usage: AssetReferrer[];
}

export class AssetsResource extends Resource {
  /**
   * Upload an image. Pass raw bytes (Uint8Array / Buffer / ArrayBuffer)
   * along with the desired filename and MIME. Server enforces image-only
   * content and a 10 MiB cap.
   */
  upload(filename: string, bytes: Uint8Array | ArrayBuffer, mime: string): Promise<Asset> {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const b64 = base64Encode(u8);
    return this.client.request("POST", "/api/v1/assets", {
      body: { filename, mime, content_base64: b64 },
    });
  }

  list(
    params: {
      limit?: number;
      before?: string;
      q?: string;
      sort?: "newest" | "oldest" | "largest" | "name" | "most-used";
      filter?: "all" | "recent" | "in-use" | "unused" | "large";
      tag?: string;
      folder_id?: string;
    } = {},
  ): Promise<AssetListPage> {
    return this.client.request("GET", "/api/v1/assets", {
      query: params,
    });
  }

  get(id: string): Promise<AssetDetail> {
    return this.client.request("GET", `/api/v1/assets/${encodeURIComponent(id)}`);
  }

  update(id: string, altText: string): Promise<Asset> {
    return this.client.request("PATCH", `/api/v1/assets/${encodeURIComponent(id)}`, {
      body: { alt_text: altText },
    });
  }

  usage(id: string): Promise<AssetUsage> {
    return this.client.request("GET", `/api/v1/assets/${encodeURIComponent(id)}/usage`);
  }

  delete(id: string, options: { force?: boolean } = {}): Promise<{ ok: true }> {
    return this.client.request("DELETE", `/api/v1/assets/${encodeURIComponent(id)}`, {
      query: { force: options.force },
    });
  }
}

function base64Encode(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  // btoa is available in browsers and in modern Node when the global is enabled.
  const btoa = (globalThis as { btoa?: (value: string) => string }).btoa;
  if (!btoa) {
    throw new Error("Asset upload requires a standards-compliant base64 encoder");
  }
  return btoa(s);
}
