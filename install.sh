#!/usr/bin/env bash
# Installer for codex-profiles
# Detects OS/arch, downloads binary from releases, verifies checksum from repo

set -euo pipefail

VERSION="${CODEX_PROFILES_VERSION:-${new_ver}}"
REPO="midhunmonachan/codex-profiles"
INSTALL_DIR="${CODEX_PROFILES_INSTALL_DIR:-$HOME/.local/bin}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    BOLD='\033[1m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    RED='\033[0;31m'
    RESET='\033[0m'
else
    BOLD='' GREEN='' YELLOW='' RED='' RESET=''
fi

info() {
    printf "${GREEN}==>${RESET} ${BOLD}%s${RESET}\n" "$*" >&2
}

warn() {
    printf "${YELLOW}warning:${RESET} %s\n" "$*" >&2
}

error() {
    printf "${RED}error:${RESET} %b\n" "$*" >&2
    exit 1
}

need_cmd() {
    if ! command -v "$1" > /dev/null 2>&1; then
        error "need '$1' (command not found)"
    fi
}

detect_platform() {
    local os arch

    case "$(uname -s)" in
        Linux*)     os="linux" ;;
        Darwin*)    os="darwin" ;;
        MINGW*|MSYS*|CYGWIN*|Windows_NT) os="windows" ;;
        *)          error "unsupported OS: $(uname -s)" ;;
    esac

    local machine
    machine="$(uname -m)"
    case "$machine" in
        x86_64|amd64)       arch="x86_64" ;;
        aarch64|arm64)      arch="aarch64" ;;
        *)                  error "unsupported architecture: $machine" ;;
    esac

    case "$os-$arch" in
        linux-x86_64)       echo "x86_64-unknown-linux-gnu" ;;
        linux-aarch64)      echo "aarch64-unknown-linux-gnu" ;;
        darwin-x86_64)      echo "x86_64-apple-darwin" ;;
        darwin-aarch64)     echo "aarch64-apple-darwin" ;;
        windows-x86_64)     echo "x86_64-pc-windows-msvc" ;;
        *)                  error "unsupported platform: $os-$arch" ;;
    esac
}

download_file() {
    local url="$1"
    local output="$2"
    local show_progress="${3:-false}"
    
    if command -v curl > /dev/null 2>&1; then
        if [ "$show_progress" = "true" ] && [ -t 1 ]; then
            # Show progress bar if stdout is a TTY
            curl -#fL --proto '=https' --tlsv1.2 "$url" -o "$output" || return 1
        else
            curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$output" || return 1
        fi
    elif command -v wget > /dev/null 2>&1; then
        if [ "$show_progress" = "true" ] && [ -t 1 ]; then
            # Show progress bar if stdout is a TTY
            wget --https-only --secure-protocol=TLSv1_2 --show-progress "$url" -O "$output" || return 1
        else
            wget -q --https-only --secure-protocol=TLSv1_2 "$url" -O "$output" || return 1
        fi
    else
        error "need 'curl' or 'wget' to download"
    fi
}

verify_checksum() {
    local file="$1"
    local checksum_file="$2"
    
    local basename
    basename="$(basename "$file")"
    local expected actual
    
    expected="$(
        awk -v name="$basename" '
            $2 ~ ("(^|/)release/" name "$") { print $1; exit }
        ' "$checksum_file"
    )"
    if [ -z "$expected" ]; then
        error "checksum not found for $basename in checksum file"
    fi
    
    if command -v sha256sum > /dev/null 2>&1; then
        actual="$(sha256sum "$file" | awk '{print $1}')"
    elif command -v shasum > /dev/null 2>&1; then
        actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    else
        warn "sha256sum/shasum not found, skipping checksum verification"
        return 0
    fi
    
    if [ "$expected" != "$actual" ]; then
        error "checksum mismatch!\n  expected: $expected\n  actual:   $actual"
    fi
    
    info "Checksum verified ✓"
}

cleanup() {
    if [ -n "${TMPDIR_INSTALL:-}" ] && [ -d "$TMPDIR_INSTALL" ]; then
        rm -rf "$TMPDIR_INSTALL"
    fi
}

main() {
    need_cmd uname
    need_cmd mkdir
    need_cmd chmod
    
    info "Installing codex-profiles v$VERSION"
    
    local target
    target="$(detect_platform)"
    info "Detected platform: $target"
    
    local base_url="https://github.com/$REPO/releases/download/v$VERSION"
    local archive_name="codex-profiles-${target}.tar.gz"
    local is_windows=0
    if [[ "$target" == *"windows"* ]]; then
        archive_name="codex-profiles-${target}.exe.zip"
        is_windows=1
        need_cmd unzip
    else
        need_cmd tar
    fi
    local archive_url="$base_url/$archive_name"
    
    local checksum_url="https://raw.githubusercontent.com/$REPO/main/checksums/v${VERSION}.txt"
    
    TMPDIR_INSTALL="$(mktemp -d)"
    trap cleanup EXIT
    local tmpdir="$TMPDIR_INSTALL"
    
    local archive_path="$tmpdir/$archive_name"
    local checksum_path="$tmpdir/checksums.txt"
    
    info "Downloading binary..."
    download_file "$archive_url" "$archive_path" "true" || error "failed to download binary from $archive_url"
    
    info "Downloading checksums from repo..."
    if ! download_file "$checksum_url" "$checksum_path" "false"; then
        if [[ "${CODEX_PROFILES_ALLOW_INSECURE_INSTALL:-0}" == "1" ]]; then
            warn "Could not download checksum file from repo"
            warn "Proceeding without verification because CODEX_PROFILES_ALLOW_INSECURE_INSTALL=1"
        else
            error "could not download checksum file from repo; aborting install.\nSet CODEX_PROFILES_ALLOW_INSECURE_INSTALL=1 to bypass (not recommended)."
        fi
    else
        verify_checksum "$archive_path" "$checksum_path"
    fi
    
    info "Extracting..."
    if [[ "${is_windows}" -eq 1 ]]; then
        unzip -q "$archive_path" -d "$tmpdir" || error "extraction failed"
    else
        tar -xzf "$archive_path" -C "$tmpdir" || error "extraction failed"
    fi
    
    # Determine binary name based on OS
    local binary_name="codex-profiles"
    if [[ "$target" == *"windows"* ]]; then
        binary_name="codex-profiles.exe"
    fi
    
    local binary_path
    if [ -f "$tmpdir/$binary_name" ]; then
        binary_path="$tmpdir/$binary_name"
    elif [ -f "$tmpdir/codex-profiles/$binary_name" ]; then
        binary_path="$tmpdir/codex-profiles/$binary_name"
    else
        error "binary not found in archive (looking for $binary_name)"
    fi
    
    info "Installing to $INSTALL_DIR/$binary_name"
    mkdir -p "$INSTALL_DIR"
    
    if [ -f "$INSTALL_DIR/$binary_name" ]; then
        local backup
        backup="$INSTALL_DIR/$binary_name.backup.$(date +%s)"
        mv "$INSTALL_DIR/$binary_name" "$backup"
        info "Backed up existing binary to $backup"
    fi
    
    cp "$binary_path" "$INSTALL_DIR/$binary_name"
    
    # Make executable on Unix-like systems (not needed on Windows)
    if [[ "$target" != *"windows"* ]]; then
        chmod +x "$INSTALL_DIR/$binary_name"
    fi
    
    if [ -f "$INSTALL_DIR/$binary_name" ]; then
        local installed_version
        installed_version="$("$INSTALL_DIR/$binary_name" --version 2>&1 || echo "unknown")"
        installed_version="$(echo "$installed_version" | head -1)"
        info "Successfully installed: $installed_version"
    else
        error "installation failed: binary is not executable"
    fi
    
    local install_dir_no_trailing="${INSTALL_DIR%/}"
    if [[ ":$PATH:" != *":${install_dir_no_trailing}:"* ]]; then
        warn "$INSTALL_DIR is not in your PATH"
        if [[ "$target" == *"windows"* ]]; then
            warn "Add this directory to your PATH environment variable"
            warn "Or run: setx PATH \"%PATH%;$INSTALL_DIR\""
        else
            warn "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
            echo "  export PATH=\"\$PATH:$INSTALL_DIR\""
        fi
    else
        info "Installation complete! Run: $binary_name --help"
    fi
}

usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Install codex-profiles by downloading the correct binary for your platform.

Options:
  -v, --version VERSION    Install specific version (default: $VERSION)
  -d, --dir DIR            Install to directory (default: $INSTALL_DIR)
  -h, --help               Show this help message

Environment variables:
  CODEX_PROFILES_VERSION          Override default version
  CODEX_PROFILES_INSTALL_DIR      Override default install directory
  CODEX_PROFILES_ALLOW_INSECURE_INSTALL  Set to 1 to bypass checksum requirement
  NO_COLOR                        Disable colored output

Security:
  Checksums are downloaded from the git repository (separate from binaries)
  to protect against compromised release artifacts.

Examples:
  $0                              # Install latest (default: v$VERSION)
  $0 --version 0.2.0             # Install specific version
  $0 --dir /usr/local/bin        # Install to custom directory

EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -v|--version)
            if [[ $# -lt 2 ]]; then
                error "missing value for $1"
            fi
            VERSION="${2#v}"
            shift 2
            ;;
        -d|--dir)
            if [[ $# -lt 2 ]]; then
                error "missing value for $1"
            fi
            INSTALL_DIR="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            error "unknown option: $1\nRun '$0 --help' for usage."
            ;;
    esac
done

main
