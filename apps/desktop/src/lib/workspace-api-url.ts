import { validateApiUrl } from "./config";

const LS_API_URL = "postwave_api_url";

/** Persist a transaction stage and prove the value survived the write. */
export function persistWorkspaceApiUrl(
  url: string,
  invalidateCache: () => void,
): void {
  const validation = validateApiUrl(url);
  if (!validation.ok) throw new Error(validation.message);
  try {
    window.localStorage.setItem(LS_API_URL, validation.url);
    if (window.localStorage.getItem(LS_API_URL) !== validation.url) {
      throw new Error("API URL persistence verification failed.");
    }
  } catch {
    throw new Error("Moosewave could not durably store the workspace API URL.");
  }
  invalidateCache();
}
