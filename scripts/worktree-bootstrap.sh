#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MANIFEST_PATH="$SCRIPT_DIR/worktree-secrets.manifest"

TARGET="$(pwd -P)"
SOURCE=""
MODE="symlink"
OVERWRITE="backup"
EXTRAS="on"
INSTALL="off"
CHECKS="off"
DRY_RUN="off"

LINK_COUNT=0
COPY_COUNT=0
SKIP_COUNT=0
BACKUP_COUNT=0
WARN_COUNT=0
ERROR_COUNT=0

# Paths relative to repo root.
declare -a CORE_PATHS=()
declare -a DEFAULT_CORE_PATHS=(
  ".env"
  ".env.local"
  ".env.development.local"
)

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/worktree-bootstrap.sh \
    [--target <path>] \
    [--source <path>] \
    [--mode symlink|copy] \
    [--overwrite backup|fail|keep] \
    [--extras on|off] \
    [--install on|off] \
    [--checks on|off] \
    [--dry-run]

Defaults:
  --target    current working directory
  --source    auto-detect canonical non-current worktree
  --mode      symlink
  --overwrite backup
  --extras    on
  --install   off (compatibility flag)
  --checks    off (compatibility flag)
USAGE
}

action_log() {
  local kind="$1"
  local message="$2"
  printf '%s %s\n' "$kind" "$message"
  case "$kind" in
    LINK) LINK_COUNT=$((LINK_COUNT + 1)) ;;
    COPY) COPY_COUNT=$((COPY_COUNT + 1)) ;;
    SKIP) SKIP_COUNT=$((SKIP_COUNT + 1)) ;;
    BACKUP) BACKUP_COUNT=$((BACKUP_COUNT + 1)) ;;
    WARN) WARN_COUNT=$((WARN_COUNT + 1)) ;;
    ERROR) ERROR_COUNT=$((ERROR_COUNT + 1)) ;;
    *) ;;
  esac
}

die() {
  action_log "ERROR" "$1"
  exit 1
}

normalize_on_off() {
  local value="$1"
  case "$value" in
    on|off) printf '%s' "$value" ;;
    *) die "Invalid on/off value: $value" ;;
  esac
}

canonical_dir() {
  local input="$1"
  [[ -d "$input" ]] || die "Directory does not exist: $input"
  (cd "$input" && pwd -P)
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --target)
        [[ $# -ge 2 ]] || die "--target requires a value"
        TARGET="$2"
        shift 2
        ;;
      --source)
        [[ $# -ge 2 ]] || die "--source requires a value"
        SOURCE="$2"
        shift 2
        ;;
      --mode)
        [[ $# -ge 2 ]] || die "--mode requires a value"
        MODE="$2"
        shift 2
        ;;
      --overwrite)
        [[ $# -ge 2 ]] || die "--overwrite requires a value"
        OVERWRITE="$2"
        shift 2
        ;;
      --extras)
        [[ $# -ge 2 ]] || die "--extras requires a value"
        EXTRAS="$(normalize_on_off "$2")"
        shift 2
        ;;
      --install)
        [[ $# -ge 2 ]] || die "--install requires a value"
        INSTALL="$(normalize_on_off "$2")"
        shift 2
        ;;
      --checks)
        [[ $# -ge 2 ]] || die "--checks requires a value"
        CHECKS="$(normalize_on_off "$2")"
        shift 2
        ;;
      --dry-run)
        DRY_RUN="on"
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
  done
}

validate_options() {
  case "$MODE" in
    symlink|copy) ;;
    *) die "Invalid --mode value: $MODE" ;;
  esac

  case "$OVERWRITE" in
    backup|fail|keep) ;;
    *) die "Invalid --overwrite value: $OVERWRITE" ;;
  esac
}

load_core_paths() {
  if [[ -f "$MANIFEST_PATH" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%%#*}"
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line%"${line##*[![:space:]]}"}"
      [[ -z "$line" ]] && continue
      CORE_PATHS+=("$line")
    done < "$MANIFEST_PATH"
  fi

  if [[ ${#CORE_PATHS[@]} -eq 0 ]]; then
    CORE_PATHS=("${DEFAULT_CORE_PATHS[@]}")
  fi
}

is_core_path() {
  local rel="$1"
  local core
  for core in "${CORE_PATHS[@]}"; do
    if [[ "$core" == "$rel" ]]; then
      return 0
    fi
  done
  return 1
}

detect_source_checkout() {
  if [[ -n "$SOURCE" ]]; then
    SOURCE="$(canonical_dir "$SOURCE")"
    return
  fi

  mapfile -t worktree_paths < <(git -C "$TARGET" worktree list --porcelain | awk '/^worktree /{sub(/^worktree /,""); print}')
  [[ ${#worktree_paths[@]} -gt 0 ]] || {
    action_log "WARN" "Could not read git worktree list from target: $TARGET"
    SOURCE=""
    return
  }

  local current="$TARGET"
  local candidate
  local first_non_current=""
  for candidate in "${worktree_paths[@]}"; do
    local candidate_abs=""
    if [[ -d "$candidate" ]]; then
      candidate_abs="$(cd "$candidate" && pwd -P)"
    fi
    [[ -n "$candidate_abs" ]] || continue
    [[ "$candidate_abs" == "$current" ]] && continue
    if [[ -z "$first_non_current" ]]; then
      first_non_current="$candidate_abs"
    fi

    local has_core=0
    local rel
    for rel in "${CORE_PATHS[@]}"; do
      if [[ -e "$candidate_abs/$rel" || -L "$candidate_abs/$rel" ]]; then
        has_core=1
        break
      fi
    done

    if [[ "$has_core" -eq 1 ]]; then
      SOURCE="$candidate_abs"
      action_log "INFO" "Auto-detected source checkout: $SOURCE"
      return
    fi
  done

  if [[ -n "$first_non_current" ]]; then
    SOURCE="$first_non_current"
    action_log "WARN" "No source checkout found with core paths; using first non-current worktree: $SOURCE"
    return
  fi

  SOURCE=""
  action_log "WARN" "No non-current worktree available for migration; continuing without source sync."
}

ensure_parent_dir() {
  local path="$1"
  local parent
  parent="$(dirname "$path")"
  if [[ "$DRY_RUN" == "on" ]]; then
    action_log "SKIP" "DRY-RUN mkdir -p $parent"
  else
    mkdir -p "$parent"
  fi
}

backup_or_skip_existing() {
  local path="$1"
  if [[ -e "$path" || -L "$path" ]]; then
    case "$OVERWRITE" in
      fail)
        die "Target already exists: $path"
        ;;
      keep)
        action_log "SKIP" "Keeping existing target: $path"
        return 1
        ;;
      backup)
        local stamp
        local backup_path
        stamp="$(date -u +%Y%m%d%H%M%S)"
        backup_path="${path}.bak.${stamp}"
        action_log "BACKUP" "$path -> $backup_path"
        if [[ "$DRY_RUN" == "off" ]]; then
          mv "$path" "$backup_path"
        fi
        ;;
      *)
        die "Unsupported overwrite mode: $OVERWRITE"
        ;;
    esac
  fi
  return 0
}

install_path() {
  local src="$1"
  local dst="$2"

  ensure_parent_dir "$dst"
  if ! backup_or_skip_existing "$dst"; then
    return 0
  fi

  if [[ "$DRY_RUN" == "on" ]]; then
    if [[ "$MODE" == "symlink" ]]; then
      action_log "LINK" "DRY-RUN $dst -> $src"
    else
      action_log "COPY" "DRY-RUN $src -> $dst"
    fi
    return 0
  fi

  if [[ "$MODE" == "symlink" ]]; then
    ln -s "$src" "$dst"
    action_log "LINK" "$dst -> $src"
  else
    if [[ -d "$src" && ! -L "$src" ]]; then
      cp -R "$src" "$dst"
    else
      cp "$src" "$dst"
    fi
    action_log "COPY" "$src -> $dst"
  fi
}

migrate_core_paths() {
  if [[ -z "$SOURCE" ]]; then
    action_log "SKIP" "No source checkout selected; skipping core path migration"
    return 0
  fi

  local rel
  for rel in "${CORE_PATHS[@]}"; do
    local src="$SOURCE/$rel"
    local dst="$TARGET/$rel"

    if [[ ! -e "$src" && ! -L "$src" ]]; then
      action_log "WARN" "Core path not present in source (skipping): $src"
      continue
    fi

    install_path "$src" "$dst"
  done
}

discover_extra_paths() {
  local source_root="$1"
  find "$source_root" \
    -path "$source_root/.git" -prune -o \
    -path "$source_root/node_modules" -prune -o \
    -path "$source_root/.cache" -prune -o \
    -path "$source_root/dist" -prune -o \
    -path "$source_root/build" -prune -o \
    -path "$source_root/out" -prune -o \
    -type f \( \
      -name "*.pem" -o \
      -name "*.key" -o \
      -name "*.p8" -o \
      -name "*.crt" -o \
      -name "*.env.*" -o \
      -name "*.secrets*" \
    \) -print | while IFS= read -r abs; do
      printf '%s\n' "${abs#"$source_root/"}"
    done

  if [[ -e "$source_root/.secrets" || -L "$source_root/.secrets" ]]; then
    printf '%s\n' ".secrets"
  fi
}

migrate_optional_extras() {
  [[ "$EXTRAS" == "on" ]] || {
    action_log "SKIP" "Optional extras migration disabled (--extras off)"
    return 0
  }

  if [[ -z "$SOURCE" ]]; then
    action_log "SKIP" "No source checkout selected; skipping optional extras migration"
    return 0
  fi

  if ! git -C "$SOURCE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    action_log "WARN" "Source is not a git repo. Skipping optional extras."
    return 0
  fi

  local rel
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    if is_core_path "$rel"; then
      continue
    fi

    if ! git -C "$SOURCE" check-ignore -q -- "$rel"; then
      action_log "WARN" "Skipping extra not ignored by git: $rel"
      continue
    fi

    if git -C "$TARGET" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then
      action_log "WARN" "Skipping extra because target path is tracked: $rel"
      continue
    fi

    local src="$SOURCE/$rel"
    local dst="$TARGET/$rel"
    if [[ ! -e "$src" && ! -L "$src" ]]; then
      action_log "WARN" "Skipping missing optional extra: $src"
      continue
    fi

    install_path "$src" "$dst"
  done < <(discover_extra_paths "$SOURCE" | awk '!seen[$0]++')
}

print_summary() {
  printf '%s\n' "INFO Summary:"
  printf '%s\n' "INFO   LINK=$LINK_COUNT COPY=$COPY_COUNT SKIP=$SKIP_COUNT BACKUP=$BACKUP_COUNT WARN=$WARN_COUNT ERROR=$ERROR_COUNT"
}

run_checks() {
  [[ "$CHECKS" == "on" ]] || return 0
  command -v git >/dev/null 2>&1 || die "Missing required tool: git"
  action_log "INFO" "Compatibility checks passed"
}

run_dependency_installs() {
  [[ "$INSTALL" == "on" ]] || return 0
  # Compatibility flag with repos that run install steps. This repo keeps setup
  # lightweight and does not auto-install dependencies during worktree creation.
  action_log "SKIP" "Install step requested, but no auto-install is configured for this repo"
}

main() {
  parse_args "$@"
  validate_options

  command -v git >/dev/null 2>&1 || die "Missing required tool: git"

  TARGET="$(canonical_dir "$TARGET")"
  load_core_paths

  detect_source_checkout
  [[ -n "$SOURCE" && "$SOURCE" == "$TARGET" ]] && die "Source and target cannot be the same path: $SOURCE"

  action_log "INFO" "Target checkout: $TARGET"
  action_log "INFO" "Source checkout: ${SOURCE:-<none>}"
  action_log "INFO" "Mode=$MODE Overwrite=$OVERWRITE Extras=$EXTRAS Install=$INSTALL Checks=$CHECKS DryRun=$DRY_RUN"

  run_checks
  migrate_core_paths
  migrate_optional_extras
  run_dependency_installs
  print_summary
}

main "$@"
