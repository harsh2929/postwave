/**
 * SubscriberDetailSlideover — right-side subscriber drill-down.
 *
 * Data loading, live engagement reconciliation, mutations, and presentation
 * live in bounded domain modules; this public component owns composition and
 * the shared slideover behavior contract.
 */
import type { ReactElement } from "react";

import { useCanAdmin, useCanWrite } from "../lib/store";
import type { SubscriberDetailProps } from "./subscriber-detail-types";
import { SubscriberDetailPresentation } from "./subscribers/SubscriberDetailPresentation";
import {
  useSubscriberDetailData,
  useSubscriberNavigation,
} from "./subscribers/useSubscriberDetailData";
import { useSubscriberDetailMutations } from "./subscribers/useSubscriberDetailMutations";

export type { SubscriberMutationHint } from "./subscriber-detail-types";

export function SubscriberDetailSlideover(
  props: SubscriberDetailProps,
): ReactElement {
  const rawId = props.subscriber.id;
  const subscriberKey =
    rawId == null
      ? `email:${props.subscriber.email.toLowerCase()}`
      : `${typeof rawId}:${String(rawId)}`;
  return <SubscriberDetailSlideoverState key={subscriberKey} {...props} />;
}

function SubscriberDetailSlideoverState({
  subscriber,
  onClose,
  onChange,
  navIndex,
  navTotal,
  onNavigate,
}: SubscriberDetailProps): ReactElement {
  const canMutate = useCanWrite();
  const canAdmin = useCanAdmin();
  const data = useSubscriberDetailData(subscriber);
  const mutations = useSubscriberDetailMutations({
    id: data.id,
    detail: data.detail,
    setDetail: data.setDetail,
    onClose,
    onChange,
    canMutate,
    canAdmin,
    reloadDetail: data.reloadDetail,
  });
  const navigation = useSubscriberNavigation({
    navIndex,
    navTotal,
    onNavigate,
    blocked:
      mutations.actionBusy || mutations.dsarBusy || mutations.jurisdictionBusy,
  });

  return (
    <SubscriberDetailPresentation
      source={{
        subscriber,
        onClose,
        onChange,
        navIndex,
        navTotal,
        onNavigate,
      }}
      navigation={navigation}
      data={data}
      mutations={mutations}
      canMutate={canMutate}
      canAdmin={canAdmin}
    />
  );
}
