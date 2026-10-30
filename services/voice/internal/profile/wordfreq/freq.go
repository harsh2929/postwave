// Package wordfreq exposes an embedded English-word-frequency baseline used
// to compute IDF for vocabulary distinctiveness.
//
// The embedded freq.txt ships the top-3000 words from Peter Norvig's
// count_1w.txt (derived from the Google Web Trillion Word Corpus,
// Brants & Franz 2006) — public domain. See freq.txt's header comment
// for the full source/license/retrieval-date provenance.
//
// If freq.txt is empty or fails to parse, load() falls back to a small
// embedded stopword list (with synthetic frequencies) so downstream
// callers always get a usable IDF function. The fallback is logged at
// init via the standard library `log` package.
package wordfreq

import (
	_ "embed"
	"log"
	"math"
	"strconv"
	"strings"
	"sync"
)

//go:embed freq.txt
var rawFreq string

var (
	once     sync.Once
	freqs    map[string]uint64
	totalSum uint64
)

// fallbackStopwords is a hand-curated top-100 list with approximate
// frequencies, used only when freq.txt fails to load. The numbers are
// rough order-of-magnitude estimates from Norvig's corpus (each tier
// roughly an order of magnitude apart) — adequate to keep stopwords
// from surfacing as themes when the embed path fails.
var fallbackStopwords = map[string]uint64{
	"the": 23000000000, "of": 13000000000, "and": 12000000000, "to": 12000000000,
	"a": 9000000000, "in": 8000000000, "for": 5000000000, "is": 4000000000,
	"on": 3700000000, "that": 3400000000, "by": 3300000000, "this": 3200000000,
	"with": 3100000000, "i": 3000000000, "you": 2900000000, "it": 2800000000,
	"not": 2600000000, "or": 2500000000, "be": 2400000000, "are": 2300000000,
	"from": 2200000000, "at": 2100000000, "as": 2200000000, "your": 2100000000,
	"all": 2000000000, "have": 2000000000, "new": 1900000000, "more": 1900000000,
	"an": 1900000000, "was": 1900000000, "we": 1800000000, "will": 1800000000,
	"home": 1700000000, "can": 1700000000, "us": 1700000000, "about": 1700000000,
	"if": 1700000000, "page": 1600000000, "my": 1600000000, "has": 1600000000,
	"but": 1500000000, "our": 1500000000, "one": 1400000000, "other": 1400000000,
	"do": 1400000000, "no": 1400000000, "they": 1300000000, "he": 1300000000,
	"up": 1300000000, "may": 1300000000, "what": 1300000000, "which": 1300000000,
	"their": 1200000000, "out": 1200000000, "use": 1100000000, "any": 1100000000,
	"there": 1100000000, "see": 1100000000, "only": 1100000000, "so": 1100000000,
	"his": 1100000000, "when": 1100000000, "who": 1000000000, "also": 1000000000,
	"now": 1000000000, "get": 950000000, "first": 870000000, "am": 860000000,
	"been": 850000000, "would": 840000000, "how": 830000000, "were": 820000000,
	"me": 810000000, "some": 800000000, "these": 790000000, "its": 780000000,
	"like": 770000000, "than": 720000000, "had": 670000000, "just": 660000000,
	"into": 630000000, "two": 620000000, "could": 600000000, "her": 510000000,
	"such": 490000000, "after": 460000000, "then": 450000000, "she": 360000000,
	"them": 540000000, "those": 290000000, "while": 260000000, "him": 260000000,
	"three": 250000000, "many": 290000000, "very": 340000000, "well": 430000000,
	"where": 420000000, "should": 540000000, "must": 130000000, "did": 60000000,
	"because": 40000000, "still": 70000000, "even": 590000000, "much": 180000000,
	"every": 4000000, "another": 12000000,
}

func load() {
	once.Do(func() {
		freqs = make(map[string]uint64, 4096)
		for _, line := range strings.Split(rawFreq, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.Fields(line)
			if len(parts) != 2 {
				continue
			}
			n, err := strconv.ParseUint(parts[1], 10, 64)
			if err != nil {
				continue
			}
			freqs[strings.ToLower(parts[0])] = n
			totalSum += n
		}
		// Fallback: if freq.txt is missing or unparseable (e.g. truncated
		// during build) we still want IDF to produce sensible stopword
		// suppression. The fallback list is small (~100 words) but covers
		// the high-frequency tail that drowns out everything else.
		if len(freqs) < 50 {
			log.Printf("wordfreq: freq.txt produced only %d entries — falling back to embedded top-100 stopwords. Themes will be slightly noisier; rebuild the binary to refresh freq.txt.", len(freqs))
			for w, c := range fallbackStopwords {
				freqs[w] = c
				totalSum += c
			}
		}
	})
}

// IDF returns the inverse-document-frequency-style weight for word against
// the embedded baseline. Unknown words are treated as maximally rare and get
// the largest weight. Stopwords return values close to zero.
//
// Computed as log((totalSum + 1) / (freq(word) + 1)).
func IDF(word string) float64 {
	load()
	w := strings.ToLower(strings.TrimSpace(word))
	if w == "" {
		return 0
	}
	f := float64(freqs[w])
	return math.Log(float64(totalSum+1) / (f + 1))
}

// Has reports whether the word is present in the baseline.
func Has(word string) bool {
	load()
	_, ok := freqs[strings.ToLower(word)]
	return ok
}
