package profile

import "strings"

// HasPassiveVoice detects common English passive constructions without a
// parser. It handles be/get auxiliaries, short adverb gaps, negated
// auxiliaries, and a curated irregular-participle set while avoiding common
// stative-adjective false positives such as "was interested in".
func HasPassiveVoice(sentence string) bool {
	tokens := passiveTokens(sentence)
	for i, tok := range tokens {
		if !passiveAuxiliaries[tok] {
			continue
		}
		j := i + 1
		for skipped := 0; j < len(tokens) && skipped < 3; skipped++ {
			if !isPassiveGap(tokens[j]) {
				break
			}
			j++
		}
		if j >= len(tokens) || !isPastParticiple(tokens[j]) {
			continue
		}
		if looksLikeStativeAdjective(tokens, j) {
			continue
		}
		return true
	}
	return false
}

func passiveTokens(sentence string) []string {
	fields := strings.Fields(sentence)
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		tok := normalizeToken(field)
		if tok == "" {
			continue
		}
		switch tok {
		case "isn't", "isnt":
			tok = "is"
		case "aren't", "arent":
			tok = "are"
		case "wasn't", "wasnt":
			tok = "was"
		case "weren't", "werent":
			tok = "were"
		}
		out = append(out, tok)
	}
	return out
}

var passiveAuxiliaries = map[string]bool{
	"am": true, "is": true, "are": true, "was": true, "were": true,
	"be": true, "been": true, "being": true,
	"get": true, "gets": true, "got": true, "gotten": true, "getting": true,
}

var passiveGapWords = map[string]bool{
	"not": true, "never": true, "no": true,
	"also": true, "already": true, "always": true, "even": true, "ever": true,
	"finally": true, "fully": true, "generally": true, "heavily": true,
	"just": true, "mostly": true, "often": true, "only": true, "partially": true,
	"poorly": true, "quietly": true, "rarely": true, "recently": true,
	"simply": true, "sometimes": true, "soon": true, "still": true,
	"usually": true, "widely": true,
}

func isPassiveGap(tok string) bool {
	return passiveGapWords[tok] || strings.HasSuffix(tok, "ly")
}

var irregularParticiples = map[string]bool{
	"begun": true, "bent": true, "bound": true, "broken": true, "brought": true,
	"built": true, "bought": true, "caught": true, "chosen": true, "cut": true,
	"done": true, "drawn": true, "driven": true, "eaten": true, "felt": true,
	"found": true, "given": true, "grown": true, "held": true, "hit": true,
	"kept": true, "known": true, "laid": true, "left": true, "lost": true,
	"made": true, "paid": true, "put": true, "read": true, "run": true,
	"said": true, "seen": true, "sent": true, "set": true, "shown": true,
	"sold": true, "split": true, "stuck": true, "taken": true, "taught": true,
	"told": true, "thought": true, "thrown": true, "won": true, "written": true,
}

var participleFalseEndings = map[string]bool{
	"bed": true, "bred": true, "dead": true, "feed": true, "red": true,
	"seed": true, "speed": true, "stead": true, "weed": true,
}

func isPastParticiple(tok string) bool {
	if irregularParticiples[tok] {
		return true
	}
	if len(tok) < 4 || participleFalseEndings[tok] {
		return false
	}
	return strings.HasSuffix(tok, "ed") || strings.HasSuffix(tok, "en")
}

var stativeParticiples = map[string]bool{
	"accustomed": true, "bored": true, "concerned": true, "convinced": true,
	"delighted": true, "done": true, "excited": true, "finished": true,
	"focused": true, "interested": true, "prepared": true, "related": true,
	"satisfied": true, "supposed": true, "surprised": true, "tired": true,
	"used": true, "worried": true,
}

var stativeComplements = map[string]bool{
	"about": true, "at": true, "for": true, "from": true, "in": true,
	"of": true, "on": true, "to": true, "with": true,
}

func looksLikeStativeAdjective(tokens []string, participleIndex int) bool {
	if participleIndex+1 >= len(tokens) {
		return false
	}
	next := tokens[participleIndex+1]
	if next == "by" {
		return false
	}
	return stativeParticiples[tokens[participleIndex]] && stativeComplements[next]
}
