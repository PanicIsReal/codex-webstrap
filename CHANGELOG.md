# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Internal

- Added `checksums/v0.2.0.txt` from release workflow output

## [0.2.0] - 2026-02-21

### Added

- `status --all --show-errors` to include errored profiles in the output
- Hidden-profile summaries in `status --all` (API profiles and errored profiles)

### Fixed

- Profile deduplication now uses a composite identity key (`principal_id` + `workspace_or_org_id` + `plan_type`) to prevent false matches
- Profile lifecycle operations now preserve update cache and handle save/load/delete edge cases more safely
- Installer trap variable scoping bug that could break cleanup on some shells
- Release bump flow now syncs npm optional package versions and installer default `VERSION` correctly
- CI cache config updated to remove deprecated `rust-cache` parameters and invalid `save-if` usage

### Changed

- Simplified profile state machine and status rendering logic
- Profile ordering changed from last-used timestamp sorting to deterministic profile-id ordering
- `list` and `status` no longer perform implicit current-profile sync side effects
- "Unknown last-used" badge is now hidden instead of shown as a placeholder

### Removed

- `status --label` support (status now targets current profile, or all profiles with `--all`)
- Last-used timestamp tracking in `profiles.json` profile metadata
- Legacy `cx` shorthand script (use `codex-profiles` directly)

### Internal

- Installer and release scripts hardened for edge-case reliability
- CI: removed unused `sccache` from workflow jobs
- Added repository checksum file for previous release (`checksums/v0.1.0.txt`)

### Documentation

- README: reorganized badges, added a tests badge, and fixed license badge color
- README: added Cargo installation instructions
- CONTRIBUTING: documented release-tag bump behavior for npm optional packages and installer defaults

## [0.1.0] - 2026-01-28

### Added

**Core Features**
- Save and load Codex CLI authentication profiles with optional labels
- Interactive profile picker with search and navigation
- List all profiles ordered by last used timestamp
- Delete profiles with confirmation prompts
- Display usage statistics (requests, costs) for profiles
- Automatic OAuth token refresh when loading expired profiles
- Support for both OAuth tokens and API keys

**CLI Experience**
- Terminal styling with color support (respects `NO_COLOR` and `FORCE_COLOR`)
- `--plain` flag to disable all styling and use raw output
- Clear error messages with actionable suggestions
- Command examples in `--help` output

**Installation**
- Smart installer script with automatic OS/architecture detection
- Checksum verification for secure downloads
- Download progress indicators with TTY detection
- Cross-platform support (Linux, macOS, Windows)
- Multiple installation methods: npm, Bun, Cargo, manual script
- Automated update checking with 24-hour interval

**Technical**
- File locking for safe concurrent operations
- Profile storage in `~/.codex/profiles/`
- Atomic file writes to prevent corruption
- 150 tests covering core functionality
- Pre-commit hooks for code quality
- Binary releases for 5 platforms (Linux x64/ARM64, macOS Intel/Apple Silicon, Windows x64)

[Unreleased]: https://github.com/midhunmonachan/codex-profiles/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/midhunmonachan/codex-profiles/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/midhunmonachan/codex-profiles/releases/tag/v0.1.0
