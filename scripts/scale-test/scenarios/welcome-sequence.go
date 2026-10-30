// © Moosewave. Proprietary and confidential.
//
// Welcome-sequence enrollment scale test.
//
// Triggers N simultaneous welcome-sequence enrollments via the
// automation runtime's `POST /v1/automations/trigger` endpoint, then
// polls each enrollment's status until it reaches `completed` (or the
// run times out).
//
// The simulated 30-day clock is exposed via the `-clock-speedup` flag.
// The automation runtime in `services/automation` honors a tenant-level
// clock-skew override (`X-Postwave-Clock-Speedup`) on staging only — see
// `services/automation/internal/clock/clock.go`.
//
// Run:
//   go run scripts/scale-test/scenarios/welcome-sequence.go \
//     -base http://localhost:8080 -bearer $POSTWAVE_BEARER \
//     -enrollments 10000 -clock-speedup 1440
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	var (
		base         = flag.String("base", "http://localhost:8080", "Moosewave API base URL")
		bearer       = flag.String("bearer", os.Getenv("POSTWAVE_BEARER"), "Bearer token")
		enrollments  = flag.Int("enrollments", 10000, "Number of simultaneous enrollments")
		concurrency  = flag.Int("concurrency", 200, "HTTP concurrency for trigger phase")
		clockSpeedup = flag.Int("clock-speedup", 1440, "Simulated minutes per real minute (staging only)")
		automation   = flag.String("automation", "welcome-7d", "Automation slug to trigger")
		pollInterval = flag.Duration("poll-interval", 5*time.Second, "Status poll interval")
		maxWait      = flag.Duration("max-wait", 60*time.Minute, "Max real-time to wait for completion")
	)
	flag.Parse()

	if *bearer == "" {
		fmt.Fprintln(os.Stderr, "POSTWAVE_BEARER (or -bearer) is required")
		os.Exit(2)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), *maxWait+10*time.Minute)
	defer cancel()

	enrollIDs := triggerAll(ctx, client, *base, *bearer, *automation, *enrollments, *concurrency, *clockSpeedup)
	fmt.Printf("triggered %d enrollments; waiting for completion...\n", len(enrollIDs))

	completed, latencies := pollUntilComplete(ctx, client, *base, *bearer, enrollIDs, *pollInterval, *maxWait)
	report(completed, len(enrollIDs), latencies)
}

type triggerReq struct {
	Automation string            `json:"automation"`
	Subscriber map[string]string `json:"subscriber"`
}
type triggerResp struct {
	EnrollmentID string `json:"enrollment_id"`
}

func triggerAll(ctx context.Context, c *http.Client, base, bearer, automation string, n, concurrency, clockSpeedup int) []string {
	ids := make([]string, 0, n)
	var mu sync.Mutex
	var wg sync.WaitGroup
	jobs := make(chan int)
	var failed atomic.Int64
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobs {
				id, err := triggerOne(ctx, c, base, bearer, automation, idx, clockSpeedup)
				if err != nil {
					failed.Add(1)
					continue
				}
				mu.Lock()
				ids = append(ids, id)
				mu.Unlock()
			}
		}()
	}
	for i := 0; i < n; i++ {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	if f := failed.Load(); f > 0 {
		fmt.Fprintf(os.Stderr, "WARNING: %d trigger calls failed\n", f)
	}
	return ids
}

func triggerOne(ctx context.Context, c *http.Client, base, bearer, automation string, idx, clockSpeedup int) (string, error) {
	body, _ := json.Marshal(triggerReq{
		Automation: automation,
		Subscriber: map[string]string{
			"email":      fmt.Sprintf("scale+welcome+%d@postwave.test", idx),
			"first_name": "Scale",
		},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/automations/trigger", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+bearer)
	if clockSpeedup > 0 {
		req.Header.Set("X-Postwave-Clock-Speedup", fmt.Sprintf("%d", clockSpeedup))
	}
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("trigger %d", resp.StatusCode)
	}
	var tr triggerResp
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return "", err
	}
	return tr.EnrollmentID, nil
}

type statusResp struct {
	State       string    `json:"state"` // running | completed | failed
	StartedAt   time.Time `json:"started_at"`
	CompletedAt time.Time `json:"completed_at"`
}

func pollUntilComplete(
	ctx context.Context, c *http.Client, base, bearer string,
	ids []string, interval, maxWait time.Duration,
) (int, []time.Duration) {
	deadline := time.Now().Add(maxWait)
	pending := map[string]bool{}
	for _, id := range ids {
		pending[id] = true
	}
	var done int
	var latencies []time.Duration

	for time.Now().Before(deadline) && len(pending) > 0 {
		var wg sync.WaitGroup
		var mu sync.Mutex
		sem := make(chan struct{}, 64)
		for id := range pending {
			id := id
			wg.Add(1)
			sem <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-sem }()
				st, err := pollOne(ctx, c, base, bearer, id)
				if err != nil {
					return
				}
				if st.State == "completed" || st.State == "failed" {
					mu.Lock()
					delete(pending, id)
					if st.State == "completed" {
						done++
						if !st.StartedAt.IsZero() && !st.CompletedAt.IsZero() {
							latencies = append(latencies, st.CompletedAt.Sub(st.StartedAt))
						}
					}
					mu.Unlock()
				}
			}()
		}
		wg.Wait()
		fmt.Printf("  pending=%d completed=%d\n", len(pending), done)
		if len(pending) == 0 {
			break
		}
		time.Sleep(interval)
	}
	return done, latencies
}

func pollOne(ctx context.Context, c *http.Client, base, bearer, id string) (statusResp, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/v1/automations/enrollments/"+id, nil)
	if err != nil {
		return statusResp{}, err
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	resp, err := c.Do(req)
	if err != nil {
		return statusResp{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return statusResp{}, fmt.Errorf("status %d", resp.StatusCode)
	}
	var st statusResp
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		return statusResp{}, err
	}
	return st, nil
}

func report(completed, total int, latencies []time.Duration) {
	fmt.Println("---")
	fmt.Printf("triggered: %d\n", total)
	fmt.Printf("completed: %d (%.2f%%)\n", completed, 100.0*float64(completed)/float64(total))
	if len(latencies) > 0 {
		sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
		p := func(q float64) time.Duration {
			i := int(q * float64(len(latencies)-1))
			return latencies[i]
		}
		fmt.Printf("p50 simulated-time-to-complete: %s\n", p(0.50))
		fmt.Printf("p95 simulated-time-to-complete: %s\n", p(0.95))
		fmt.Printf("p99 simulated-time-to-complete: %s\n", p(0.99))
	}
}
