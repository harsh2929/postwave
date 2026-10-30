//go:build !linux

package uploadstore

// Non-Linux hosts use the explicit development filesystem backend for tests.
func IsSharedMount(string) bool { return false }
