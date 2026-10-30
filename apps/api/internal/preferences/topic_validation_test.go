// SPDX-License-Identifier: AGPL-3.0-only
package preferences

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateCreateTopicInputBoundsPublicProjection(t *testing.T) {
	t.Parallel()
	valid := CreateTopicInput{
		Slug:         " product-updates ",
		Name:         " Product updates ",
		Description:  " Important releases. ",
		DisplayOrder: 1,
	}
	if err := validateCreateTopicInput(&valid); err != nil {
		t.Fatalf("validateCreateTopicInput() error = %v", err)
	}
	if valid.Slug != "product-updates" || valid.Name != "Product updates" || valid.Description != "Important releases." {
		t.Fatalf("normalized input = %#v", valid)
	}

	cases := []struct {
		name string
		in   CreateTopicInput
		want error
	}{
		{name: "uppercase slug", in: CreateTopicInput{Slug: "Product", Name: "Product"}, want: ErrInvalidTopicSlug},
		{name: "oversized slug", in: CreateTopicInput{Slug: strings.Repeat("a", topicSlugMaxBytes+1), Name: "Product"}, want: ErrInvalidTopicSlug},
		{name: "control name", in: CreateTopicInput{Slug: "product", Name: "Product\u202E"}, want: ErrInvalidTopicName},
		{name: "oversized description", in: CreateTopicInput{Slug: "product", Name: "Product", Description: strings.Repeat("x", topicDescriptionMaxBytes+1)}, want: ErrInvalidTopicDesc},
		{name: "order", in: CreateTopicInput{Slug: "product", Name: "Product", DisplayOrder: topicDisplayOrderMax + 1}, want: ErrInvalidTopicOrder},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if err := validateCreateTopicInput(&tc.in); !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestValidateTopicOptInsRequiresUniqueCanonicalUUIDs(t *testing.T) {
	t.Parallel()
	valid := []TopicOptIn{{TopicID: "11111111-1111-4111-8111-111111111111", OptedIn: true}}
	if err := validateTopicOptIns(valid); err != nil {
		t.Fatalf("validateTopicOptIns() error = %v", err)
	}

	for _, items := range [][]TopicOptIn{
		{{TopicID: "not-a-uuid"}},
		{{TopicID: "11111111-1111-4111-8111-111111111111"}, {TopicID: "11111111-1111-4111-8111-111111111111"}},
		make([]TopicOptIn, publicPreferenceMaxTopics+1),
	} {
		if err := validateTopicOptIns(items); !errors.Is(err, ErrInvalidTopicChoice) {
			t.Fatalf("validateTopicOptIns(%d items) error = %v", len(items), err)
		}
	}
}
