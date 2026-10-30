// SPDX-License-Identifier: AGPL-3.0-only
package feedback

import "testing"

func TestTransactionalOutcomeVocabularyExcludesEngagement(t *testing.T) {
	for _, outcome := range []string{"delivered", "bounced", "complained", "deferred"} {
		if !validTransactionalOutcome(outcome) {
			t.Errorf("mailbox outcome %q was rejected", outcome)
		}
	}
	for _, engagement := range []string{"opened", "clicked", "human_opened", "machine_clicked"} {
		if validTransactionalOutcome(engagement) {
			t.Errorf("engagement %q entered the mailbox outcome ledger", engagement)
		}
	}
}

func TestTransactionalOutcomeRecipientsAreCaseInsensitiveAndStable(t *testing.T) {
	got := uniqueOutcomeRecipients([]string{
		" First@Example.test ", "first@example.test", "SECOND@example.test", "", "second@example.test",
	})
	if len(got) != 2 || got[0] != "first@example.test" || got[1] != "second@example.test" {
		t.Fatalf("unique recipients = %#v", got)
	}
}
