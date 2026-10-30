// SPDX-License-Identifier: AGPL-3.0-only
package routeauth

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var templateParameter = regexp.MustCompile(`\{[^{}]+\}`)

type routeMatcher struct {
	methods map[string]*matchNode
}

type matchNode struct {
	static  map[string]*matchNode
	dynamic []*dynamicEdge
	rest    *Policy
	policy  *Policy
}

type dynamicEdge struct {
	shape       string
	staticBytes int
	pattern     *regexp.Regexp
	node        *matchNode
}

func newRouteMatcher() *routeMatcher {
	return &routeMatcher{methods: map[string]*matchNode{}}
}

func newMatchNode() *matchNode {
	return &matchNode{static: map[string]*matchNode{}}
}

func (m *routeMatcher) insert(policy *Policy) error {
	root := m.methods[policy.Method]
	if root == nil {
		root = newMatchNode()
		m.methods[policy.Method] = root
	}
	segments := splitPath(normalizeTemplate(policy.Path))
	node := root
	for index, segment := range segments {
		if segment == "{rest}" {
			if index != len(segments)-1 {
				return fmt.Errorf("{rest} must be the final segment")
			}
			if node.rest != nil {
				return fmt.Errorf("ambiguous wildcard path")
			}
			node.rest = policy
			return nil
		}
		if !strings.Contains(segment, "{") {
			child := node.static[segment]
			if child == nil {
				child = newMatchNode()
				node.static[segment] = child
			}
			node = child
			continue
		}
		shape := templateParameter.ReplaceAllString(segment, "{}")
		var edge *dynamicEdge
		for _, candidate := range node.dynamic {
			if candidate.shape == shape {
				edge = candidate
				break
			}
		}
		if edge == nil {
			pattern, staticBytes, err := compileSegment(segment)
			if err != nil {
				return err
			}
			edge = &dynamicEdge{
				shape:       shape,
				staticBytes: staticBytes,
				pattern:     pattern,
				node:        newMatchNode(),
			}
			node.dynamic = append(node.dynamic, edge)
			sort.SliceStable(node.dynamic, func(i, j int) bool {
				return node.dynamic[i].staticBytes > node.dynamic[j].staticBytes
			})
		}
		node = edge.node
	}
	if node.policy != nil {
		return fmt.Errorf("ambiguous route template")
	}
	node.policy = policy
	return nil
}

func compileSegment(segment string) (*regexp.Regexp, int, error) {
	indices := templateParameter.FindAllStringIndex(segment, -1)
	if len(indices) == 0 {
		return nil, 0, fmt.Errorf("malformed template segment %q", segment)
	}
	var expression strings.Builder
	expression.WriteString("^")
	last := 0
	staticBytes := 0
	for _, pair := range indices {
		literal := segment[last:pair[0]]
		expression.WriteString(regexp.QuoteMeta(literal))
		staticBytes += len(literal)
		expression.WriteString("[^/]+")
		last = pair[1]
	}
	literal := segment[last:]
	expression.WriteString(regexp.QuoteMeta(literal))
	staticBytes += len(literal)
	expression.WriteString("$")
	pattern, err := regexp.Compile(expression.String())
	if err != nil {
		return nil, 0, fmt.Errorf("compile segment %q: %w", segment, err)
	}
	return pattern, staticBytes, nil
}

func (m *routeMatcher) match(method, path string) *Policy {
	segments := splitPath(path)
	if root := m.methods[method]; root != nil {
		if policy := matchSegments(root, segments, 0); policy != nil {
			return policy
		}
	}
	if root := m.methods["ANY"]; root != nil {
		return matchSegments(root, segments, 0)
	}
	return nil
}

func matchSegments(node *matchNode, segments []string, index int) *Policy {
	if index == len(segments) {
		if node.policy != nil {
			return node.policy
		}
		return node.rest
	}
	segment := segments[index]
	if child := node.static[segment]; child != nil {
		if policy := matchSegments(child, segments, index+1); policy != nil {
			return policy
		}
	}
	for _, edge := range node.dynamic {
		if edge.pattern.MatchString(segment) {
			if policy := matchSegments(edge.node, segments, index+1); policy != nil {
				return policy
			}
		}
	}
	return node.rest
}

func splitPath(path string) []string {
	trimmed := strings.TrimPrefix(path, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

func normalizeRequestPath(path string) string {
	if path == "" {
		return "/"
	}
	if len(path) > 1 && strings.HasSuffix(path, "/") {
		return strings.TrimSuffix(path, "/")
	}
	return path
}

func normalizeTemplate(path string) string {
	normalized := normalizeRequestPath(strings.TrimSpace(path))
	if strings.HasSuffix(normalized, "/*") {
		normalized = strings.TrimSuffix(normalized, "/*") + "/{rest}"
	}
	normalized = regexp.MustCompile(`\{([^}:]+):[^}]+\}`).ReplaceAllString(normalized, `{$1}`)
	return normalized
}
