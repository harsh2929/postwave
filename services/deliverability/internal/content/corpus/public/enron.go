package public

// enron.go — loader for the Enron-Spam corpus by Metsis, Androutsopoulos
// and Paliouras (AUEB, 2006).
//
// Source: http://nlp.cs.aueb.gr/software_and_datasets/Enron-Spam/
// The corpus is distributed as six per-user tarballs (enron1..enron6).
// Each tarball expands to:
//
//	enronN/
//	  spam/<id>.txt
//	  ham/<id>.txt
//
// The .txt files are pre-cleaned: the first line is the Subject, a
// blank line follows, then the plain-text body. Headers other than
// Subject have already been stripped by the dataset authors — this
// is intentional from AUEB to focus models on content, not envelope
// metadata.
//
// Labels are entirely directory-based: spam/ -> IsSpam=true,
// ham/ -> IsSpam=false. The Enron half (ham/) is corporate email
// from 158 Enron employees (2001-2002). The spam half is harvested
// from honeypot mailboxes maintained by the corpus authors,
// 2003-2005.

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/content/corpus"
)

// EnronAssets returns the six per-user tarballs. The canonical
// download URL has shifted over the years; we use the AUEB mirror
// because it ships well-formed UTF-8 archives. SHA256 digests are
// left empty intentionally — the AUEB mirror occasionally re-bundles
// without changing the visible filename.
func EnronAssets() []Asset {
	const base = "http://nlp.cs.aueb.gr/software_and_datasets/Enron-Spam/preprocessed/"
	out := make([]Asset, 0, 6)
	for i := 1; i <= 6; i++ {
		out = append(out, Asset{
			Dataset: "enron",
			Name:    fmt.Sprintf("enron%d.tar.gz", i),
			URL:     fmt.Sprintf("%senron%d.tar.gz", base, i),
			SHA256:  "",
		})
	}
	return out
}

// LoadEnron walks <cacheDir>/enron/, extracting each enronN.tar.gz
// archive on first invocation and then emitting one Sample per .txt
// file. Returns (nil, nil) when the dataset directory is missing.
func LoadEnron(ctx context.Context, cacheDir string) ([]corpus.Sample, error) {
	root := filepath.Join(cacheDir, "enron")
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return nil, nil
	} else if err != nil {
		return nil, fmt.Errorf("stat %s: %w", root, err)
	}

	extracted := filepath.Join(root, "extracted")
	if err := os.MkdirAll(extracted, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir extracted: %w", err)
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("readdir %s: %w", root, err)
	}
	for _, e := range entries {
		if err := ctxErr(ctx); err != nil {
			return nil, err
		}
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".tar.gz") {
			continue
		}
		// Heuristic: trust the archive's own top-level dir name. We
		// skip re-extraction only if the matching enronN directory
		// already has files.
		stem := strings.TrimSuffix(name, ".tar.gz")
		dst := filepath.Join(extracted, stem)
		if alreadyExtracted(dst) {
			continue
		}
		if err := extractTarGz(filepath.Join(root, name), extracted); err != nil {
			return nil, fmt.Errorf("extract %s: %w", name, err)
		}
	}

	var samples []corpus.Sample
	walkErr := filepath.WalkDir(extracted, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctxErr(ctx); err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(path), ".txt") {
			return nil
		}
		rel, err := filepath.Rel(extracted, path)
		if err != nil {
			return err
		}
		parts := strings.Split(filepath.ToSlash(rel), "/")
		if len(parts) < 3 {
			// Expect "<enronN>/<spam|ham>/<id>.txt".
			return nil
		}
		// parts[0] == "enron1".."enron6"; parts[1] == "spam"|"ham".
		bucket := strings.ToLower(parts[1])
		var isSpam bool
		switch bucket {
		case "spam":
			isSpam = true
		case "ham":
			isSpam = false
		default:
			return nil
		}
		raw, err := readCorpusMessageFile(path)
		if err != nil {
			return fmt.Errorf("read %s: %w", path, err)
		}
		subj, body := parseEnronMessage(raw)
		if subj == "" && len(body) < 4 {
			return nil
		}
		samples = append(samples, corpus.Sample{
			Subject:  subj,
			BodyHTML: body,
			Text:     subj + "\n\n" + body,
			IsSpam:   isSpam,
			Source:   "enron/" + parts[0] + "/" + bucket,
			SampleAt: enronSampleAt(isSpam),
		})
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}
	return samples, nil
}

// enronSampleAt assigns a coarse era timestamp. Enron mail bodies
// originate 2001-2002 (the FERC subpoena window). The spam half was
// collected 2003-2005. We pick 2002 for ham and 2004 for spam so
// downstream consumers can window by era if they want.
func enronSampleAt(isSpam bool) time.Time {
	if isSpam {
		return time.Date(2004, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	return time.Date(2002, 1, 1, 0, 0, 0, 0, time.UTC)
}

// parseEnronMessage splits an Enron-Spam .txt file into (subject,
// body). The AUEB preprocessing convention is:
//
//	Subject: <line>
//	<blank>
//	<body...>
//
// or just a raw subject as the first line. We're permissive of both.
func parseEnronMessage(raw []byte) (subject, body string) {
	s := string(raw)
	// First line is the subject (with or without "Subject: " prefix).
	nl := strings.Index(s, "\n")
	if nl < 0 {
		// One-line files: no body.
		return strings.TrimSpace(strings.TrimPrefix(s, "Subject:")), ""
	}
	first := s[:nl]
	rest := s[nl+1:]
	if strings.HasPrefix(strings.ToLower(first), "subject:") {
		subject = strings.TrimSpace(first[len("subject:"):])
	} else {
		subject = strings.TrimSpace(first)
	}
	// Strip leading blank line(s) from the body.
	body = strings.TrimLeft(rest, "\r\n")
	return subject, body
}

// extractTarGz unpacks a .tar.gz archive into destRoot, applying the
// same tar-slip defenses as extractTarBz2.
func extractTarGz(src, destRoot string) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	defer func() { _ = gz.Close() }()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("tar next: %w", err)
		}
		clean := filepath.Clean(hdr.Name)
		if strings.HasPrefix(clean, "..") || strings.HasPrefix(clean, "/") || strings.Contains(clean, "/../") {
			continue
		}
		target := filepath.Join(destRoot, clean)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.Create(target)
			if err != nil {
				return err
			}
			if _, err := io.CopyN(out, tr, hdr.Size); err != nil && err != io.EOF {
				_ = out.Close()
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
		default:
			continue
		}
	}
}
