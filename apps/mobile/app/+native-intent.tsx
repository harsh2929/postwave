/** Normalize system URLs before Expo Router attempts to match them. */
import { rewriteNativeSystemPath } from "@/lib/nativeIntent";

export function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}) {
  return rewriteNativeSystemPath(path);
}
