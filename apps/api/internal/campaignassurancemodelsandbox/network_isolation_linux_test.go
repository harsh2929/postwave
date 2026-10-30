// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package campaignassurancemodelsandbox

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"testing"

	"golang.org/x/sys/unix"
)

func TestLinuxSeccompEnforcerDeniesInternetSocketsProcessWide(t *testing.T) {
	if os.Getenv("POSTWAVE_SECCOMP_HELPER") == "1" {
		enforcer, err := NewProcessNetworkIsolationEnforcer()
		if err != nil {
			os.Exit(20)
		}
		attestation, err := enforcer.Enforce(context.Background())
		if err != nil || !attestation.valid() {
			os.Exit(21)
		}
		for _, domain := range []int{unix.AF_INET, unix.AF_INET6} {
			descriptor, socketErr := unix.Socket(domain, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
			if socketErr == nil {
				_ = unix.Close(descriptor)
				os.Exit(22)
			}
			if !errors.Is(socketErr, unix.EPERM) {
				os.Exit(23)
			}
		}
		unixDescriptor, err := unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
		if err != nil {
			os.Exit(24)
		}
		_ = unix.Close(unixDescriptor)
		os.Exit(0)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestLinuxSeccompEnforcerDeniesInternetSocketsProcessWide$")
	command.Env = append(os.Environ(), "POSTWAVE_SECCOMP_HELPER=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("seccomp helper: %v\n%s", err, output)
	}
}
