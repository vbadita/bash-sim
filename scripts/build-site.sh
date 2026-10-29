#!/usr/bin/env bash
# Assemble the deployable site: site/ plus version.json naming the commit.
#   usage: scripts/build-site.sh <out-dir> <commit>
set -euo pipefail
out=$1
commit=$2
root="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf "$out"
mkdir -p "$out"
cp -R "$root/site/." "$out/"
printf '{"commit": "%s", "built": "%s"}\n' "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out/version.json"
# every module must at least parse
for f in "$out"/js/*.js "$out"/js/cmds/*.js; do node --check "$f"; done
echo "site built in $out ($(du -sh "$out" | cut -f1)) for $commit"
