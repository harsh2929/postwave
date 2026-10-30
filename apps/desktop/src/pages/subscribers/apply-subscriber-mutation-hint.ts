import type { SubscriberMutationHint } from "../../components/SubscriberDetailSlideover";
import type { Subscriber } from "../../lib/api-client";
import { subscriberKey } from "./subscribers-page-utils";
import type { SubscribersData } from "./useSubscribersData";
import type { SubscribersPageState } from "./useSubscribersPageState";

export function applySubscriberMutationHint(
  state: SubscribersPageState,
  data: SubscribersData,
  onAudienceMutation: () => void,
  selectedKey: string,
  updated: Subscriber | null,
  hint: SubscriberMutationHint,
): boolean {
  onAudienceMutation();
  if (hint.kind === "remove") {
    if (state.showArchived) return false;
    data.markLocalRowMutation(selectedKey, false);
    data.setRows((current) =>
      current
        ? current.filter((row) => subscriberKey(row) !== selectedKey)
        : current,
    );
    return true;
  }
  data.markLocalRowMutation(selectedKey);
  data.setRows((current) =>
    current
      ? current.map((row) =>
          subscriberKey(row) === selectedKey ? { ...row, ...hint.delta } : row,
        )
      : current,
  );
  if (updated) state.setSelected(updated);
  else {
    state.setSelected((selected) =>
      selected && subscriberKey(selected) === selectedKey
        ? { ...selected, ...hint.delta }
        : selected,
    );
  }
  return true;
}
