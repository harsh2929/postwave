package streaming_export

import "testing"

func TestStreamingPublicProjectionRemovesStorageAndFailureDetail(t *testing.T) {
	public := sanitizeRun(&Run{ObjectURI: "tenant/private/object", Error: "provider detail"})
	if public.ObjectURI != "" || public.Error != "" {
		t.Fatalf("private streaming detail escaped: %+v", public)
	}
	if !public.IssuePresent {
		t.Fatal("issue presence flag was not retained")
	}
}
