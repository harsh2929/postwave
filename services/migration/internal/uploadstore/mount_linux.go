//go:build linux

package uploadstore

import "golang.org/x/sys/unix"

// IsSharedMount rejects overlayfs/tmpfs when an EFS volume is missing. EFS is
// mounted as NFSv4 by ECS; a directory environment variable alone is not enough.
func IsSharedMount(path string) bool {
	var info unix.Statfs_t
	return unix.Statfs(path, &info) == nil && info.Type == 0x6969 // NFS_SUPER_MAGIC
}
