# Local development on Windows

The Moosewave repo is built and tested primarily on macOS. This document
captures the Windows-specific prerequisites and the bring-up sequence.
If you find a Windows-only issue, file it or PR a fix here.

## Prerequisites

Install via [winget](https://learn.microsoft.com/windows/package-manager/winget/)
unless noted otherwise:

```powershell
# Core toolchain
winget install --id Git.Git -e
winget install --id GoLang.Go -e
winget install --id OpenJS.NodeJS.LTS -e        # Node 22+
winget install --id pnpm.pnpm -e                # used by all JS packages
winget install --id Rustlang.Rustup -e          # required by Tauri desktop
winget install --id Microsoft.VisualStudio.2022.BuildTools -e
# In the Build Tools installer, select:
#   "Desktop development with C++"  (Tauri toolchain)

# Optional but extremely useful
winget install --id Docker.DockerDesktop -e     # for docker-compose infra
winget install --id Microsoft.PowerShell -e     # pwsh 7+ for the fanout script
```

### Tauri-specific extras

The desktop app uses [Tauri](https://tauri.app/), which on Windows needs:

- **Microsoft WebView2 runtime** — ships with Windows 11; on Windows 10 install from
  <https://developer.microsoft.com/microsoft-edge/webview2/>
- The **Build Tools "Desktop development with C++"** workload, installed above.
- After installing Rust via rustup, also install the MSVC target:
  `rustup default stable-x86_64-pc-windows-msvc`

## Choose a shell

Two shells work:

- **PowerShell 7+** (recommended). Comes with `pwsh`. Run `.ps1` scripts directly.
- **Git Bash** (ships with Git for Windows). Run `.sh` scripts directly.

Avoid `cmd.exe` — several setup steps assume PowerShell or POSIX semantics.

If PowerShell rejects scripts ("running scripts is disabled"), enable user-scoped
script execution **once**:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

## Clone

```powershell
git clone https://github.com/harsh2929/postwave.git C:\dev\postwave
cd C:\dev\postwave
```

Set Git to leave line endings alone — Moosewave's CI is LF-only and
re-normalising on checkout corrupts shell scripts:

```powershell
git config core.autocrlf input
```

## Bring up the env

Moosewave reads env from per-app files. Edit ONE root file and fan it out:

```powershell
# Copy the template
copy .env.local.example .env.local

# Fill in the GENERATE_ME values. On Windows you can use Git Bash:
#   openssl rand -hex 32        # for 32-byte hex (peppers, salts)
#   openssl rand -base64 32     # for 32-byte b64 (KEKs)
# ...or generate them on macOS / Linux and paste them in.

# Fan out to apps/api/.env, apps/web/.env.local, apps/desktop/.env
.\scripts\dev-fanout-env.ps1
```

### Transferring an existing .env from another machine

If you already have a working `.env.local` / `infra/mvp/.env.mvp` from
another machine (e.g. your macOS dev box), the recommended transfer is
OneDrive (preinstalled on Windows):

1. On macOS: copy the file into your local OneDrive folder.
2. Wait for OneDrive to sync.
3. On Windows: copy from your OneDrive folder into the repo root as
   `.env.local`, then run the fan-out script.

**Do not commit `.env.local` to git.** It is already in `.gitignore`.

## Install + build

```powershell
# JavaScript / TypeScript (pnpm reads pnpm-workspace.yaml)
pnpm install

# Go modules
go work sync         # the repo uses a Go workspace
go mod download

# Per-app sanity checks
cd apps\desktop
pnpm exec tsc --noEmit          # typecheck
pnpm exec vite build            # web build smoke test
cd ..\..

cd apps\web
pnpm exec next build            # next build smoke test
cd ..\..

cd apps\api
go build ./...                  # Go gateway compiles
cd ..\..
```

## Bring up the infra (postgres + listmonk)

```powershell
# Docker Desktop must be running first.
docker compose -f infra\docker-compose.yml up -d postgres listmonk
```

If you don't want Docker, you can run a native Postgres and adjust
`DATABASE_URL` in `.env.local` accordingly. Listmonk has no easy
native-Windows path — use Docker for it.

## Run the apps

In three separate PowerShell windows:

```powershell
# Window 1 - Go gateway on :8080
cd C:\dev\postwave\apps\api
go run .

# Window 2 - Next.js on :3000
cd C:\dev\postwave\apps\web
pnpm dev

# Window 3 - Vite + Tauri desktop on :1420
cd C:\dev\postwave\apps\desktop
pnpm dev
```

The desktop app will open a Tauri window pointing at the local Vite
server. The web app is at <http://localhost:3000>. The API is at
<http://localhost:8080>.

## Known Windows-specific gotchas

This section is intentionally a stub - we expect the first Windows
bring-up to discover issues. PRs that add to this list are welcome.

- `chmod +x` calls in `.sh` scripts are no-ops on Windows (Git tracks
  the execute bit but NTFS doesn't enforce it). Use `bash script.sh` /
  `pwsh script.ps1` explicitly.
- Some `pnpm` postinstall scripts call POSIX tools. If you see "rm: not
  recognized", run the install from inside Git Bash instead of cmd.
- The Tauri Rust toolchain needs the MSVC linker. If you see "linker
  `link.exe` not found", you missed the "Desktop development with C++"
  workload in Visual Studio Build Tools.
- Long paths: Windows caps file paths at 260 chars unless long-path
  support is enabled. If you see ENAMETOOLONG, run as admin:
  `New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force`

## When something doesn't work

The recommended workflow is to spin up a Claude Code session in the
repo and let it autonomously diagnose. See the bring-up prompt at the
bottom of this doc.
