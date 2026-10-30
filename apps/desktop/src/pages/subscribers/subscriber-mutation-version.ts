import { toast } from "../../components/Toast";
import {
  isExactSubscriberVersion,
  type Subscriber,
} from "../../lib/api-client";

export function requireSubscriberVersion(
  row: Subscriber,
  message: string,
): string | null {
  const version = row.version;
  if (!isExactSubscriberVersion(version)) {
    toast.error(message);
    return null;
  }
  return version;
}
