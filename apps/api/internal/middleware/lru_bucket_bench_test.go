// SPDX-License-Identifier: AGPL-3.0-only
//
// lru_bucket_bench_test.go — micro-benchmarks for the BoundedBuckets
// Update path's contention behaviour.
//
// Why this exists:
//
//   Before p4c-bounded-buckets-mutex, BoundedBuckets.Update held the
//   global LRU mutex while running the caller-provided fn. That meant
//   every concurrent reservation across every key contended on ONE
//   lock, even though each fn only touched its own per-bucket state.
//
//   These benchmarks demonstrate the contention profile:
//
//     - SingleKey: N goroutines hammer ONE key. The per-entry mutex
//       still serialises them (this is the worst case and is *expected*
//       to scale roughly with parallelism × work-per-call, not
//       parallelism alone).
//     - MultiKey: N goroutines hammer N distinct keys. With the old
//       global-lock design these would serialise on b.mu; with the new
//       design they only contend on the brief list/map critical
//       section and otherwise run in parallel.
//
//   Run with:
//     go test -bench=BoundedBucketsUpdate -benchmem ./internal/middleware
//
//   The MultiKey numbers should be DRAMATICALLY higher ops/sec than
//   SingleKey when GOMAXPROCS>1; under the old design they were within
//   ~15% of each other (global-lock dominated).

package middleware

import (
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// benchPayload is a tiny per-bucket payload to mirror the rate-limit
// use case (a counter + a timestamp). Holds nothing that introduces
// extra synchronisation — the per-entry mutex inside BoundedBuckets
// is what serialises mutations to a single key.
type benchPayload struct {
	count int64
	at    time.Time
}

// BenchmarkBoundedBucketsUpdate_SingleKey: all goroutines hit the
// same key. With the new design they serialise on the per-entry
// mutex; with the old design they serialised on the global mutex. The
// total work per iteration is the same — but this is the bound for
// hot-key contention.
func BenchmarkBoundedBucketsUpdate_SingleKey(b *testing.B) {
	bb := NewBoundedBuckets[*benchPayload]("bench_single", 1024, time.Hour)
	now := time.Now()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			bb.Update("hot", now, func(existing *benchPayload, hit bool) *benchPayload {
				if existing == nil {
					existing = &benchPayload{}
				}
				existing.count++
				existing.at = now
				return existing
			})
		}
	})
}

// BenchmarkBoundedBucketsUpdate_MultiKey: goroutines hit distinct
// keys. This is the headline benchmark: with the OLD design every key
// serialised on b.mu so this would behave like SingleKey. With the
// NEW design the global mutex is only held for the O(1)
// list/map work and fn runs under per-entry mutexes, so different
// keys do not block each other.
func BenchmarkBoundedBucketsUpdate_MultiKey(b *testing.B) {
	bb := NewBoundedBuckets[*benchPayload]("bench_multi", 16_384, time.Hour)
	now := time.Now()
	// Pre-warm so we measure the steady-state path (no factory
	// allocations in the hot loop).
	for i := 0; i < 1024; i++ {
		bb.Update(strconv.Itoa(i), now, func(existing *benchPayload, hit bool) *benchPayload {
			return &benchPayload{}
		})
	}
	var counter int64
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			// Cycle through 1024 keys so every goroutine touches a
			// different bucket the vast majority of the time.
			i := atomic.AddInt64(&counter, 1) & 1023
			key := strconv.FormatInt(i, 10)
			bb.Update(key, now, func(existing *benchPayload, hit bool) *benchPayload {
				if existing == nil {
					existing = &benchPayload{}
				}
				existing.count++
				existing.at = now
				return existing
			})
		}
	})
}

// BenchmarkBoundedBucketsUpdate_SingleKey_Sequential: lower bound for
// fn-only cost (no contention at all). Useful as a reference point
// when comparing the two parallel benchmarks above.
func BenchmarkBoundedBucketsUpdate_SingleKey_Sequential(b *testing.B) {
	bb := NewBoundedBuckets[*benchPayload]("bench_seq", 1024, time.Hour)
	now := time.Now()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		bb.Update("hot", now, func(existing *benchPayload, hit bool) *benchPayload {
			if existing == nil {
				existing = &benchPayload{}
			}
			existing.count++
			existing.at = now
			return existing
		})
	}
}
