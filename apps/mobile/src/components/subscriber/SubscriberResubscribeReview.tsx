/**
 * SubscriberResubscribeReview — the consent review a Resubscribe must pass.
 *
 * Extracted from app/(tabs)/subscribers/[id].tsx when the screen hit its
 * function-size budget; behaviour is unchanged. The screen owns WHEN the
 * review opens (the Resubscribe verb); this component owns the sheet, the
 * mutation and the receipts, so the screen cannot accidentally grow a
 * second, evidence-free path to `status:"enabled"`.
 */
import { useToast } from "@/components/Toast";
import { ConsentEvidenceSheet } from "@/components/subscriber/ConsentEvidenceSheet";
import { useSubscriberResubscribeConsent } from "@/hooks/useSubscriberResubscribeConsent";
import { haptics } from "@/lib/haptics";
import { CONSENT_RESUBSCRIBE_SOURCES } from "@/lib/subscriberConsentEvidence";

export function SubscriberResubscribeReview({
  visible,
  id,
  email,
  onClose,
}: {
  visible: boolean;
  id: string;
  email: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const resubscribe = useSubscriberResubscribeConsent();

  return (
    <ConsentEvidenceSheet
      visible={visible}
      title="Review consent to resubscribe"
      subtitle={`This creates a new email-marketing grant for ${email}. Independent bounce, complaint, and manual suppressions still apply.`}
      sources={CONSENT_RESUBSCRIBE_SOURCES}
      requireEvidence
      submitLabel="Record consent and resubscribe"
      busy={resubscribe.isPending}
      submitError={
        resubscribe.error instanceof Error
          ? resubscribe.error.message
          : undefined
      }
      onClose={() => {
        if (!resubscribe.isPending) onClose();
      }}
      onSubmit={(draft) => {
        haptics.warning();
        resubscribe.mutate(
          { id, draft },
          {
            onSuccess: () => {
              haptics.success();
              onClose();
              toast({
                kind: "success",
                message: `Consent recorded for ${email}. They are subscribed again.`,
              });
            },
            // The sheet stays open with the server's sentence under the
            // form — a failed consent grant must never look recorded.
            onError: () => haptics.error(),
          },
        );
      }}
    />
  );
}
