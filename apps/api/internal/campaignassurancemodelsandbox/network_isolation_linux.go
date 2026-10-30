// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package campaignassurancemodelsandbox

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	auditArchX8664           = 0xc000003e
	auditArchAARCH64         = 0xc00000b7
	seccompSetModeFilter     = 1
	seccompFilterFlagTSync   = 1
	seccompReturnKillProcess = 0x80000000
	seccompReturnErrno       = 0x00050000
	seccompReturnAllow       = 0x7fff0000
	seccompDataArchOffset    = 4
	seccompDataArgsOffset    = 16
)

type linuxNetworkIsolationEnforcer struct{}

func newProcessNetworkIsolationEnforcer() (NetworkIsolationEnforcer, error) {
	switch runtime.GOARCH {
	case "amd64", "arm64":
		return linuxNetworkIsolationEnforcer{}, nil
	default:
		return nil, fmt.Errorf("%w: unsupported Linux architecture %s", ErrNetworkIsolation, runtime.GOARCH)
	}
}

func (linuxNetworkIsolationEnforcer) Enforce(ctx context.Context) (NetworkIsolationAttestation, error) {
	if cause := context.Cause(ctx); cause != nil {
		return NetworkIsolationAttestation{}, cause
	}
	architecture := uint32(auditArchX8664)
	if runtime.GOARCH == "arm64" {
		architecture = auditArchAARCH64
	}
	filter := []unix.SockFilter{
		// Verify the native audit architecture. A mismatched ABI is killed so
		// it cannot reinterpret SYS_SOCKET as another syscall number.
		{Code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, K: seccompDataArchOffset},
		{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, Jt: 1, Jf: 0, K: architecture},
		{Code: unix.BPF_RET | unix.BPF_K, K: seccompReturnKillProcess},
		{Code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, K: 0},
		{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, Jt: 0, Jf: 3, K: uint32(unix.SYS_SOCKET)},
		{Code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, K: seccompDataArgsOffset},
		{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, Jt: 2, Jf: 0, K: unix.AF_INET},
		{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, Jt: 1, Jf: 0, K: unix.AF_INET6},
		{Code: unix.BPF_RET | unix.BPF_K, K: seccompReturnAllow},
		{Code: unix.BPF_RET | unix.BPF_K, K: seccompReturnErrno | uint32(unix.EPERM)},
	}
	program := unix.SockFprog{Len: uint16(len(filter)), Filter: &filter[0]}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return NetworkIsolationAttestation{}, fmt.Errorf("%w: set no-new-privileges", ErrNetworkIsolation)
	}
	_, _, syscallErr := unix.Syscall(
		unix.SYS_SECCOMP,
		uintptr(seccompSetModeFilter), uintptr(seccompFilterFlagTSync),
		uintptr(unsafe.Pointer(&program)),
	)
	if syscallErr != 0 {
		return NetworkIsolationAttestation{}, fmt.Errorf("%w: install process-wide seccomp filter", ErrNetworkIsolation)
	}
	if err := verifyDeniedInternetSockets(); err != nil {
		return NetworkIsolationAttestation{}, err
	}
	unixSocket, err := unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return NetworkIsolationAttestation{}, fmt.Errorf("%w: AF_UNIX verification", ErrNetworkIsolation)
	}
	_ = unix.Close(unixSocket)
	if err := verifyNoInternetSocketDescriptors(); err != nil {
		return NetworkIsolationAttestation{}, err
	}
	return NetworkIsolationAttestation{
		seal: networkIsolationSeal, processWide: true, noNewPrivs: true,
		afINETDenied: true, afINET6Denied: true, afUNIXAllowed: true, noInternetFDs: true,
	}, nil
}

// A socket-creation filter cannot neutralize an inherited internet socket.
// After the process-wide filter is installed (so the set cannot grow), inspect
// every live descriptor through /proc and fail closed if any AF_INET/AF_INET6
// socket was inherited from the launcher.
func verifyNoInternetSocketDescriptors() error {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return fmt.Errorf("%w: inspect inherited descriptors", ErrNetworkIsolation)
	}
	for _, entry := range entries {
		descriptor, parseErr := strconv.Atoi(entry.Name())
		if parseErr != nil {
			continue
		}
		domain, socketErr := unix.GetsockoptInt(descriptor, unix.SOL_SOCKET, unix.SO_DOMAIN)
		if socketErr != nil {
			continue // The descriptor is not a socket or closed during inspection.
		}
		if domain == unix.AF_INET || domain == unix.AF_INET6 {
			return fmt.Errorf("%w: inherited internet socket descriptor", ErrNetworkIsolation)
		}
	}
	return nil
}

func verifyDeniedInternetSockets() error {
	for _, domain := range []int{unix.AF_INET, unix.AF_INET6} {
		descriptor, err := unix.Socket(domain, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
		if err == nil {
			_ = unix.Close(descriptor)
			return fmt.Errorf("%w: address family %d remained available", ErrNetworkIsolation, domain)
		}
		if !errors.Is(err, unix.EPERM) {
			return fmt.Errorf("%w: address family %d verification", ErrNetworkIsolation, domain)
		}
	}
	return nil
}
