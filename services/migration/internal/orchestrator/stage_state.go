package orchestrator

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/postwave/migrate/canonical"
)

const stageDoneCursorPrefix = "__postwave_stage_done__:"
const verifierCheckpointCursorKey = "__postwave_verifier_checkpoint"
const maxInlineVerifierCheckpointBytes = 256 << 10

const (
	stageSubscribers   = "subscribers"
	stageSegments      = "segments"
	stageTemplates     = "templates"
	stageAutomations   = "automations"
	stageArchive       = "archive"
	stageSourceArchive = "source_archive"
	stagePaidSubs      = "paid_subs"
)

var executionStages = []string{
	stageSubscribers,
	stageSegments,
	stageTemplates,
	stageAutomations,
	stageArchive,
	stageSourceArchive,
	stagePaidSubs,
}

func stageDoneKey(stage string) string {
	return stageDoneCursorPrefix + stage
}

func stageCompleted(job *canonical.MigrationJob, stage string) bool {
	if job == nil || job.Cursor == nil {
		return false
	}
	value, ok := job.Cursor[stageDoneKey(stage)]
	return ok && value != nil && strings.EqualFold(strings.TrimSpace(*value), "true")
}

func markStageCompleted(job *canonical.MigrationJob, stage string) {
	if job == nil {
		return
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	value := "true"
	job.Cursor[stageDoneKey(stage)] = &value
}

// ResetExecutionState clears only resource execution cursors and completion
// sentinels. Control-plane entries (selected audiences, OAuth/session state,
// mode flags) are deliberately preserved. Handlers must call this before a
// fresh dry-run, commit, or delta execution; recovery retries must not.
func ResetExecutionState(job *canonical.MigrationJob) {
	if job == nil || job.Cursor == nil {
		return
	}
	for _, stage := range executionStages {
		delete(job.Cursor, stage)
		delete(job.Cursor, stageDoneKey(stage))
	}
	delete(job.Cursor, automationTemplateMapCursorKey)
	delete(job.Cursor, beehiivArchiveClassificationCutoffCursorKey)
	delete(job.Cursor, verifierCheckpointCursorKey)
}

// ResetSubscriberVerificationState makes a cancelled job safe to resume after
// its raw DB-backed subscriber observations have been erased. The subscriber
// destination upsert is idempotent, so replaying this one stage rebuilds the
// verification evidence without re-running later completed stages.
func ResetSubscriberVerificationState(job *canonical.MigrationJob) error {
	if job == nil {
		return nil
	}
	job.Progress.SubscribersDone = 0
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
		return nil
	}
	delete(job.Cursor, stageSubscribers)
	delete(job.Cursor, stageDoneKey(stageSubscribers))
	raw := job.Cursor[verifierCheckpointCursorKey]
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	checkpoint := loadVerifierCheckpoint(job)
	clearSubscriberVerifierState(checkpoint)
	return persistVerifierCheckpoint(job, checkpoint)
}

func loadVerifierCheckpoint(job *canonical.MigrationJob) *VerifierInput {
	checkpoint := NewVerifierInput()
	if job == nil || job.Cursor == nil || job.Cursor[verifierCheckpointCursorKey] == nil {
		return checkpoint
	}
	if err := json.Unmarshal([]byte(*job.Cursor[verifierCheckpointCursorKey]), checkpoint); err != nil {
		return NewVerifierInput()
	}
	ensureVerifierMaps(checkpoint)
	return checkpoint
}

func persistVerifierCheckpoint(job *canonical.MigrationJob, verifier *VerifierInput, compactSubscribers ...bool) error {
	if job == nil || verifier == nil {
		return nil
	}
	checkpoint := verifier
	if len(compactSubscribers) > 0 && compactSubscribers[0] {
		cp := *verifier
		clearSubscriberVerifierState(&cp)
		checkpoint = &cp
	}
	raw, err := json.Marshal(checkpoint)
	if err != nil {
		return err
	}
	if len(raw) > maxInlineVerifierCheckpointBytes {
		return fmt.Errorf("verification checkpoint is %d bytes (limit %d); configure tenant-scoped DB checkpoint storage for resumable subscriber verification", len(raw), maxInlineVerifierCheckpointBytes)
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	value := string(raw)
	job.Cursor[verifierCheckpointCursorKey] = &value
	return nil
}

func clearSubscriberVerifierState(verifier *VerifierInput) {
	if verifier == nil {
		return
	}
	verifier.SubscribersSeen = 0
	verifier.SubscribersSkipped = 0
	verifier.SubscribersErrored = 0
	verifier.SuppressionListSize = 0
	verifier.ConsentKnown = 0
	verifier.ConsentUnknown = 0
	verifier.SubscriberTagsSeen = 0
	verifier.SubscriberTagsUnique = map[string]struct{}{}
	verifier.SubscriberTagCounts = map[string]int{}
	verifier.SubscriberSourceIDs = map[string]struct{}{}
	verifier.PremiumMembershipsObserved = 0
	verifier.StaticSegmentMemberships = 0
	verifier.CustomFieldsSeen = map[string]string{}
	verifier.CustomFieldsCanonical = map[string]string{}
	verifier.SubscriberFirstSeen = map[string]canonical.Subscriber{}
	verifier.SubscriberMergeConflicts = map[string]canonical.SubscriberMergeConflict{}
}

func ensureVerifierMaps(v *VerifierInput) {
	if v.CustomFieldsSeen == nil {
		v.CustomFieldsSeen = map[string]string{}
	}
	if v.CustomFieldsCanonical == nil {
		v.CustomFieldsCanonical = map[string]string{}
	}
	if v.SubscriberTagsUnique == nil {
		v.SubscriberTagsUnique = map[string]struct{}{}
	}
	if v.SubscriberTagCounts == nil {
		v.SubscriberTagCounts = map[string]int{}
	}
	if v.SubscriberSourceIDs == nil {
		v.SubscriberSourceIDs = map[string]struct{}{}
	}
	if v.SubscriberFirstSeen == nil {
		v.SubscriberFirstSeen = map[string]canonical.Subscriber{}
	}
	if v.SubscriberMergeConflicts == nil {
		v.SubscriberMergeConflicts = map[string]canonical.SubscriberMergeConflict{}
	}
	if v.SegmentTranslateErrs == nil {
		v.SegmentTranslateErrs = map[string]string{}
	}
	if v.SourceArchiveByType == nil {
		v.SourceArchiveByType = map[string]int{}
	}
}
