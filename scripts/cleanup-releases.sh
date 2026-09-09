#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

fail() { echo "Release cleanup failed: $*" >&2; exit 1; }
validate_keep() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] || fail 'KEEP_RELEASES must be a positive integer (without leading zeros).'
}

if [[ "${1:-}" == --validate ]]; then
  [[ $# == 2 ]] || fail 'Usage: cleanup-releases.sh --validate KEEP_RELEASES'
  validate_keep "$2"
  exit 0
fi
[[ $# == 1 || $# == 2 ]] || fail 'Usage: cleanup-releases.sh BASEDIR [KEEP_RELEASES]'
keep=${2-5}
validate_keep "$keep"
basedir=$(cd -- "$1" && pwd -P) || fail "Cannot open deployment directory: $1"
[[ "$basedir" != / ]] || fail 'Refusing to clean the filesystem root.'
[[ -L "$basedir/server.js" && -f "$basedir/server.js" ]] || fail 'server.js must be a symlink to an existing file.'
active_target=$(readlink -f -- "$basedir/server.js") || fail 'Cannot resolve server.js.'
[[ "$active_target" == "$basedir/"* ]] || fail 'Current version is outside the deployment directory.'
relative=${active_target#"$basedir/"}
active=${relative%%/*}
[[ "$relative" == */* && "$active" =~ ^[0-9]+$ && -d "$basedir/$active" && ! -L "$basedir/$active" ]] || fail 'Cannot identify a real numeric directory for the current version.'

versions=()
for dir in "$basedir"/*; do
  name=${dir##*/}
  if [[ "$name" =~ ^[0-9]+$ && -d "$dir" && ! -L "$dir" ]]; then
    versions+=("$name")
  fi
done
sorted=$(printf '%s\n' "${versions[@]}" | sort -rn) || fail 'Cannot sort release directories.'
kept=1
printf 'Keeping current release: %s\n' "$basedir/$active"
while IFS= read -r version; do
  [[ "$version" != "$active" ]] || continue
  # Compare decimal strings to avoid overflow for large KEEP_RELEASES values.
  if [[ ${#kept} -lt ${#keep} ]] || { [[ ${#kept} -eq ${#keep} ]] && [[ "$kept" < "$keep" ]]; }; then
    printf 'Keeping release: %s\n' "$basedir/$version"
    kept=$((kept + 1))
    continue
  fi
  # Abort if the deployment entry changes during cleanup.
  [[ "$(readlink -f -- "$basedir/server.js")" == "$active_target" ]] || fail 'Current version changed during cleanup.'
  [[ -d "$basedir/$version" && ! -L "$basedir/$version" ]] || fail "Release directory changed: $basedir/$version"
  printf 'Deleting release: %s\n' "$basedir/$version"
  rm -rf -- "$basedir/$version" || fail "Cannot delete release: $basedir/$version"
  [[ ! -e "$basedir/$version" && ! -L "$basedir/$version" ]] || fail "Release still exists: $basedir/$version"
done <<< "$sorted"
printf 'Release cleanup complete; retained %s release(s).\n' "$kept"
