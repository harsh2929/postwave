package stuckworker

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/handlers"
)

type fakeActivity struct {
	rows []handlers.ParticipantActivity
	err  error
}

func (f *fakeActivity) ListActivity(context.Context, string, string) ([]handlers.ParticipantActivity, error) {
	return f.rows, f.err
}

type recordedEvent struct {
	tenantID  string
	eventType string
	body      map[string]any
}

type fakeEmitter struct{ events []recordedEvent }

func (f *fakeEmitter) Emit(_ context.Context, tenantID, eventType string, body any) error {
	m, ok := body.(map[string]any)
	if !ok {
		return fmt.Errorf("unexpected body type %T", body)
	}
	f.events = append(f.events, recordedEvent{tenantID, eventType, m})
	return nil
}

func seedSequence(t *testing.T, stuckAfterDays int, goal *generation.SequenceGoal) *handlers.MemorySequenceStore {
	t.Helper()
	seqs := handlers.NewMemorySequenceStore()
	if err := seqs.Save(context.Background(), generation.Sequence{
		ID:             "seq-1",
		TenantID:       "tenant-1",
		Name:           "Onboarding",
		Status:         "active",
		StuckAfterDays: stuckAfterDays,
		Goal:           goal,
		Steps: []generation.Step{
			{Type: generation.StepTypeEmail, Position: 1, Email: &generation.EmailConfig{Subject: "1", Body: "1"}},
			{Type: generation.StepTypeEmail, Position: 2, Email: &generation.EmailConfig{Subject: "2", Body: "2"}},
		},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	return seqs
}

func TestScanSequenceEmitsAlertForStuckParticipants(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	emitter := &fakeEmitter{}
	w := &Worker{
		Sequences: seedSequence(t, 7, nil),
		Activity: &fakeActivity{rows: []handlers.ParticipantActivity{
			{SubscriberID: "s1", Email: "stuck@x.com", CurrentStep: 1,
				LastEventAt: now.Add(-10 * 24 * time.Hour), SubscriberActive: true},
			{SubscriberID: "s2", Email: "fresh@x.com", CurrentStep: 1,
				LastEventAt: now.Add(-time.Hour), SubscriberActive: true},
		}},
		Emitter: emitter,
		Now:     func() time.Time { return now },
	}
	alerted, err := w.ScanSequence(context.Background(), "tenant-1", "seq-1")
	if err != nil {
		t.Fatalf("ScanSequence: %v", err)
	}
	if !alerted || len(emitter.events) != 1 {
		t.Fatalf("alerted=%v events=%d, want one alert", alerted, len(emitter.events))
	}
	ev := emitter.events[0]
	if ev.tenantID != "tenant-1" || ev.eventType != EventType {
		t.Fatalf("event = %+v", ev)
	}
	if ev.body["sequence_id"] != "seq-1" || ev.body["sequence_name"] != "Onboarding" ||
		ev.body["threshold_days"] != 7 || ev.body["stuck_count"] != 1 {
		t.Fatalf("body = %+v", ev.body)
	}
	items, ok := ev.body["items"].([]handlers.StuckParticipant)
	if !ok || len(items) != 1 || items[0].Email != "stuck@x.com" || items[0].IdleDays != 10 {
		t.Fatalf("items = %+v", ev.body["items"])
	}
}

func TestScanSequenceSkipsWhenNothingStuck(t *testing.T) {
	emitter := &fakeEmitter{}
	w := &Worker{
		Sequences: seedSequence(t, 7, nil),
		Activity:  &fakeActivity{},
		Emitter:   emitter,
	}
	alerted, err := w.ScanSequence(context.Background(), "tenant-1", "seq-1")
	if err != nil || alerted || len(emitter.events) != 0 {
		t.Fatalf("alerted=%v err=%v events=%d, want quiet pass", alerted, err, len(emitter.events))
	}
}

func TestScanSequenceSkipsWhenDisabled(t *testing.T) {
	now := time.Now().UTC()
	emitter := &fakeEmitter{}
	w := &Worker{
		Sequences: seedSequence(t, 0, nil), // disabled between enumeration and scan
		Activity: &fakeActivity{rows: []handlers.ParticipantActivity{
			{Email: "stuck@x.com", CurrentStep: 1,
				LastEventAt: now.Add(-100 * 24 * time.Hour), SubscriberActive: true},
		}},
		Emitter: emitter,
	}
	alerted, err := w.ScanSequence(context.Background(), "tenant-1", "seq-1")
	if err != nil || alerted || len(emitter.events) != 0 {
		t.Fatalf("alerted=%v err=%v events=%d, want skip", alerted, err, len(emitter.events))
	}
}

func TestScanSequenceExcludesGoalMetParticipants(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	emitter := &fakeEmitter{}
	w := &Worker{
		Sequences: seedSequence(t, 7, &generation.SequenceGoal{Kind: generation.GoalKindOpen, ExitOnGoal: true}),
		Activity: &fakeActivity{rows: []handlers.ParticipantActivity{
			{Email: "openedlongago@x.com", CurrentStep: 1, AnyOpen: true,
				LastEventAt: now.Add(-30 * 24 * time.Hour), SubscriberActive: true},
		}},
		Emitter: emitter,
		Now:     func() time.Time { return now },
	}
	alerted, err := w.ScanSequence(context.Background(), "tenant-1", "seq-1")
	if err != nil || alerted {
		t.Fatalf("alerted=%v err=%v, want goal-met participant excluded", alerted, err)
	}
}

func TestScanSequenceCapsAlertItems(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	rows := make([]handlers.ParticipantActivity, 0, 30)
	for i := 0; i < 30; i++ {
		rows = append(rows, handlers.ParticipantActivity{
			SubscriberID:     fmt.Sprintf("s%02d", i),
			Email:            fmt.Sprintf("u%02d@x.com", i),
			CurrentStep:      1,
			LastEventAt:      now.Add(-time.Duration(8+i) * 24 * time.Hour),
			SubscriberActive: true,
		})
	}
	emitter := &fakeEmitter{}
	w := &Worker{
		Sequences: seedSequence(t, 7, nil),
		Activity:  &fakeActivity{rows: rows},
		Emitter:   emitter,
		Now:       func() time.Time { return now },
	}
	if _, err := w.ScanSequence(context.Background(), "tenant-1", "seq-1"); err != nil {
		t.Fatalf("ScanSequence: %v", err)
	}
	if len(emitter.events) != 1 {
		t.Fatalf("events = %d, want 1", len(emitter.events))
	}
	body := emitter.events[0].body
	if body["stuck_count"] != 30 {
		t.Fatalf("stuck_count = %v, want 30", body["stuck_count"])
	}
	items := body["items"].([]handlers.StuckParticipant)
	if len(items) != alertMaxItems {
		t.Fatalf("items = %d, want %d (capped)", len(items), alertMaxItems)
	}
	// Most idle first: the cap keeps the worst offenders.
	if items[0].IdleDays < items[len(items)-1].IdleDays {
		t.Fatalf("items not sorted most-idle first: %d .. %d", items[0].IdleDays, items[len(items)-1].IdleDays)
	}
}

func TestScanSequenceRequiresWiring(t *testing.T) {
	w := &Worker{}
	if _, err := w.ScanSequence(context.Background(), "tenant-1", "seq-1"); err == nil {
		t.Fatal("expected error when stores are not wired")
	}
}
