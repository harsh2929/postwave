// postwave-verify is a standalone CLI that re-verifies a Moosewave
// audit-log inclusion proof against an audit-log CSV export, using
// only the Go standard library. Customers can drop the binary on any
// machine (no DB, no network) and prove the integrity of an audit
// row offline.
//
//	go run ./apps/api/cmd/postwave-verify \
//	    --csv   postwave-audit-2026-06-03.csv \
//	    --proof inclusion-proof.json
//
// Exit 0 = proof verified, anything else = failure with reason on stderr.
package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

type proofJSON struct {
	LeafID        int64    `json:"leaf_id"`
	LeafHash      string   `json:"leaf_hash"`
	AuditPath     []string `json:"audit_path"`
	TreeSize      int64    `json:"tree_size"`
	RootHash      string   `json:"root_hash"`
	RootSignature string   `json:"root_signature"`
	RootKid       string   `json:"root_kid"`
	AnchoredAt    string   `json:"anchored_at"`
}

type rowRec struct {
	id           int64
	tenantID     string
	userID       string
	action       string
	resourceType string
	resourceID   string
	metaJSON     string
	ip           string
	userAgent    string
	actorType    string
	actorLabel   string
	at           time.Time
}

func canonicalBytes(r rowRec) []byte {
	var b []byte
	put := func(s string) {
		var l [4]byte
		binary.BigEndian.PutUint32(l[:], uint32(len(s)))
		b = append(b, l[:]...)
		b = append(b, []byte(s)...)
	}
	putI := func(n int64) {
		var l [8]byte
		binary.BigEndian.PutUint64(l[:], uint64(n))
		b = append(b, l[:]...)
	}
	putI(r.id)
	put(r.tenantID)
	put(r.userID)
	put(r.action)
	put(r.resourceType)
	put(r.resourceID)
	put(r.metaJSON)
	put(r.ip)
	put(r.userAgent)
	put(r.actorType)
	put(r.actorLabel)
	putI(r.at.UnixNano())
	return b
}

func rowHash(r rowRec, prev []byte) []byte {
	h := sha256.New()
	h.Write(canonicalBytes(r))
	h.Write(prev)
	return h.Sum(nil)
}

// loadCSV reads a Moosewave audit export and returns rows indexed by id.
// The CSV column order is: id,at,action,resource_type,resource_id,
// actor_type,actor_label,user_id,ip,user_agent,metadata_json
// (matches handlers.Export). Tenant id is NOT in the export CSV today;
// we pass it via --tenant for now.
func loadCSV(path string, tenantID string) (map[int64]rowRec, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open csv: %w", err)
	}
	defer func() { _ = f.Close() }()
	rdr := csv.NewReader(f)
	rdr.FieldsPerRecord = -1
	header, err := rdr.Read()
	if err != nil {
		return nil, fmt.Errorf("csv header: %w", err)
	}
	col := map[string]int{}
	for i, n := range header {
		col[strings.TrimSpace(n)] = i
	}
	required := []string{"id", "at", "action"}
	for _, r := range required {
		if _, ok := col[r]; !ok {
			return nil, fmt.Errorf("csv missing required column %q", r)
		}
	}
	out := map[int64]rowRec{}
	for {
		rec, err := rdr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("csv read: %w", err)
		}
		get := func(name string) string {
			if i, ok := col[name]; ok && i < len(rec) {
				return rec[i]
			}
			return ""
		}
		idV, err := strconv.ParseInt(get("id"), 10, 64)
		if err != nil {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, get("at"))
		if err != nil {
			at, err = time.Parse(time.RFC3339, get("at"))
			if err != nil {
				continue
			}
		}
		meta := get("metadata_json")
		if meta == "" {
			meta = "{}"
		}
		// Re-canonicalise metadata via json.Marshal to match Go's
		// encoding/json output (no inserted whitespace, but key order
		// preserved per the original).
		var m map[string]any
		if err := json.Unmarshal([]byte(meta), &m); err == nil {
			b, _ := json.Marshal(m)
			meta = string(b)
		}
		actorType := get("actor_type")
		if actorType == "" {
			actorType = "human"
		}
		out[idV] = rowRec{
			id:           idV,
			tenantID:     tenantID,
			userID:       get("user_id"),
			action:       get("action"),
			resourceType: get("resource_type"),
			resourceID:   get("resource_id"),
			metaJSON:     meta,
			ip:           get("ip"),
			userAgent:    get("user_agent"),
			actorType:    actorType,
			actorLabel:   get("actor_label"),
			at:           at,
		}
	}
	return out, nil
}

func verify(proof proofJSON, rows map[int64]rowRec) error {
	leafHash, err := hex.DecodeString(proof.LeafHash)
	if err != nil {
		return fmt.Errorf("decode leaf_hash: %w", err)
	}
	rootHash, err := hex.DecodeString(proof.RootHash)
	if err != nil {
		return fmt.Errorf("decode root_hash: %w", err)
	}
	cur := leafHash
	for i, hex := range proof.AuditPath {
		want, err := decodeHex(hex)
		if err != nil {
			return fmt.Errorf("path[%d] decode: %w", i, err)
		}
		rowID := proof.LeafID + int64(i) + 1
		row, ok := rows[rowID]
		if !ok {
			return fmt.Errorf("csv missing row id=%d (path index %d)", rowID, i)
		}
		got := rowHash(row, cur)
		if !bytesEqual(got, want) {
			return fmt.Errorf("path[%d] mismatch at row id=%d\n  got  %x\n  want %x",
				i, rowID, got, want)
		}
		cur = got
	}
	if !bytesEqual(cur, rootHash) {
		return fmt.Errorf("final hash != root_hash\n  got  %x\n  want %x", cur, rootHash)
	}
	return nil
}

func decodeHex(s string) ([]byte, error) { return hex.DecodeString(s) }

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func main() {
	csvPath := flag.String("csv", "", "path to audit CSV export from /api/v1/audit/export")
	proofPath := flag.String("proof", "", "path to inclusion-proof JSON")
	tenantID := flag.String("tenant", "", "tenant id (uuid) the CSV was exported from")
	flag.Parse()
	if *csvPath == "" || *proofPath == "" {
		fmt.Fprintln(os.Stderr, "usage: postwave-verify --csv <file> --proof <file> [--tenant <uuid>]")
		os.Exit(2)
	}
	proofBytes, err := os.ReadFile(*proofPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "FAIL:", err)
		os.Exit(1)
	}
	var p proofJSON
	if err := json.Unmarshal(proofBytes, &p); err != nil {
		fmt.Fprintln(os.Stderr, "FAIL: decode proof:", err)
		os.Exit(1)
	}
	rows, err := loadCSV(*csvPath, *tenantID)
	if err != nil {
		fmt.Fprintln(os.Stderr, "FAIL:", err)
		os.Exit(1)
	}
	if err := verify(p, rows); err != nil {
		fmt.Fprintln(os.Stderr, "FAIL:", err)
		os.Exit(1)
	}
	fmt.Printf("OK: %d rows verified, root=%s...\n", len(p.AuditPath), trim(p.RootHash, 16))
	fmt.Printf("    anchored_at=%s tree_size=%d\n", p.AnchoredAt, p.TreeSize)
	if p.RootSignature != "" {
		fmt.Printf("    root_signature available (kid=%s) — verify with your KMS trust anchor\n", p.RootKid)
	}
}

func trim(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
