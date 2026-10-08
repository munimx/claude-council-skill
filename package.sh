#!/usr/bin/env bash
# Build dist/council.zip for skill marketplaces such as Agensi.
#
# Layout: one top-level folder named after the skill, SKILL.md directly inside it, text files only.
# Adds LICENSE and a sample report, and leaves out OS junk. Re-run after any change to council/.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
stage=$(mktemp -d "${TMPDIR:-/tmp}/council-package.XXXXXX")
trap 'rm -rf "${stage:?}"' EXIT

rsync -a --exclude .DS_Store --exclude __pycache__ "$here/council/" "$stage/council/"
mkdir -p "$stage/council/examples"
cp "$here/LICENSE" "$stage/council/LICENSE"
cp "$here/council-workspace/sample-report-gil.md" "$stage/council/examples/sample-report.md"

name=$(sed -n 's/^name: *//p' "$stage/council/SKILL.md" | head -1)
[ "$name" = council ] || { echo "package.sh: SKILL.md name is '$name', expected 'council'" >&2; exit 1; }
if find "$stage" -type l | grep -q .; then echo "package.sh: symlinks in package" >&2; exit 1; fi
find "$stage" -type f | while read -r f; do
  case $(file -b --mime-encoding "$f") in us-ascii|utf-8) ;; *) echo "package.sh: not a text file: $f" >&2; exit 1 ;; esac
done

mkdir -p "$here/dist"
rm -f "$here/dist/council.zip"
(cd "$stage" && zip -qrX "$here/dist/council.zip" council)
echo "dist/council.zip ($(du -h "$here/dist/council.zip" | cut -f1 | tr -d ' ')):"
unzip -l "$here/dist/council.zip" | sed -n '4,$p' | awk 'NF==4 {print "  " $4}'
