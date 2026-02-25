#!/usr/bin/env bash
set -euo pipefail

version="${1:-}"
out_dir="${2:-dist}"

if [[ -z "${version}" ]]; then
  version=$(python3 - <<'PY'
import json
with open("package.json", "r", encoding="utf-8") as fh:
    print(json.load(fh)["version"])
PY
  )
fi

version="${version#v}"

release_dir="${out_dir}/release"
npm_packages_dir="${out_dir}/npm-packages"
homebrew_dir="${out_dir}/homebrew"
cargo_dir="${out_dir}/cargo"
checksums_file="${out_dir}/checksums/SHA256SUMS"

if [[ ! -d "${release_dir}" ]]; then
  echo "Missing release dir: ${release_dir}" >&2
  exit 1
fi

if [[ ! -d "${npm_packages_dir}" ]]; then
  echo "Missing npm packages dir: ${npm_packages_dir}" >&2
  exit 1
fi

if [[ ! -d "${cargo_dir}" ]]; then
  echo "Missing cargo dir: ${cargo_dir}" >&2
  exit 1
fi

if [[ ! -f "${checksums_file}" ]]; then
  echo "Missing checksums file: ${checksums_file}" >&2
  exit 1
fi

has_release_assets=0
shopt -s nullglob
for artifact_dir in "${out_dir}/artifacts"/codex-profiles-*; do
  target="${artifact_dir##*/codex-profiles-}"
  if [[ "${target}" == *windows* ]]; then
    expected="${release_dir}/codex-profiles-${target}.exe.zip"
  else
    expected="${release_dir}/codex-profiles-${target}.tar.gz"
  fi
  if [[ ! -f "${expected}" ]]; then
    echo "Missing release asset: ${expected}" >&2
    exit 1
  fi
  has_release_assets=1
done
shopt -u nullglob

if [[ "${has_release_assets}" -eq 0 ]]; then
  echo "No build artifacts found under ${out_dir}/artifacts" >&2
  exit 1
fi

main_pkg="${npm_packages_dir}/codex-profiles-${version}.tgz"
if [[ ! -f "${main_pkg}" ]]; then
  echo "Missing npm main package: ${main_pkg}" >&2
  exit 1
fi

crate="${cargo_dir}/codex-profiles-${version}.crate"
if [[ ! -f "${crate}" ]]; then
  echo "Missing cargo crate: ${crate}" >&2
  exit 1
fi

if [[ -f "${release_dir}/codex-profiles-aarch64-apple-darwin.tar.gz" || \
      -f "${release_dir}/codex-profiles-x86_64-apple-darwin.tar.gz" ]]; then
  if [[ ! -f "${homebrew_dir}/codex-profiles.rb" ]]; then
    echo "Missing Homebrew cask: ${homebrew_dir}/codex-profiles.rb" >&2
    exit 1
  fi
fi

if [[ ! -s "${checksums_file}" ]]; then
  echo "Checksums file is empty: ${checksums_file}" >&2
  exit 1
fi
