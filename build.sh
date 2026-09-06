#!/usr/bin/env bash
# Assemble the Satin XPI.
#
# Used both by default.nix and by anyone building without Nix, so that the
# instructions in the README cannot drift from what actually gets built.
#
#   ./build.sh [output.xpi]
#
# Environment:
#   PDFJS_ZIP  a pdf.js dist zip to use instead of downloading one
#   VERSION    version to stamp into the manifest (Firefox will only replace an
#              installed copy with a higher one)
#   EXT_DIR    the add-on sources, when they are not beside this script (Nix
#              builds copy the script into the store on its own)
#   PATCH      the pdf.js patch, likewise
#   UNPACKED_DIR  also leave the assembled tree here. Chrome's "Load unpacked"
#              wants a directory, not an archive, and that is the only way to
#              install this without a Web Store listing.
#
# The archive is not Firefox-specific despite the .xpi name: one manifest covers
# both engines (background declares `scripts` for Firefox and `service_worker`
# for Chrome, and each ignores the other's key), so the same bytes load in
# Chrome, Edge, Brave, Vivaldi and Opera.
#
# Needs: bash, curl, unzip, zip, patch.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ext_dir=${EXT_DIR:-$here/ext}
patch_file=${PATCH:-$here/pdfjs-viewer-html.patch}
out=${1:-$here/satin.xpi}
version=${VERSION:-0.0.0}
pdfjs_version=6.2.108
# Firefox refuses pre-1980 timestamps in a zip, and a fixed one keeps the
# archive byte-identical across builds.
: "${SOURCE_DATE_EPOCH:=315532800}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cp -r "$ext_dir/." "$work/"
chmod -R u+w "$work"
mkdir -p "$work/pdfjs"

zip_path=${PDFJS_ZIP:-}
if [ -z "$zip_path" ]; then
  zip_path=$work/pdfjs.zip
  curl -sSLo "$zip_path" \
    "https://github.com/mozilla/pdf.js/releases/download/v$pdfjs_version/pdfjs-$pdfjs_version-dist.zip"
fi
unzip -q "$zip_path" -d "$work/pdfjs"
rm -f "$work/pdfjs.zip"

# The one edit a patch file cannot express, because the value differs per build.
manifest=$work/manifest.json
placeholder='"version": "0.0.0"'
if ! grep -qF "$placeholder" "$manifest"; then
  echo "build.sh: version placeholder missing from manifest.json" >&2
  exit 1
fi
content=$(cat "$manifest")
printf '%s\n' "${content//$placeholder/\"version\": \"$version\"}" >"$manifest"

# The only file in the pdf.js distribution this build touches: one line of
# viewer.html, adding the controller and its stylesheet. --fuzz=0 so that a
# pdf.js upgrade which moves the anchor fails the build rather than shipping a
# viewer with the tint code silently dropped.
patch -p1 -d "$work/pdfjs" --fuzz=0 --no-backup-if-mismatch <"$patch_file"


find "$work" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
rm -f "$out"
(cd "$work" && zip -q -r -X -D -9 "$out" .)

if [ -n "${UNPACKED_DIR:-}" ]; then
  rm -rf "$UNPACKED_DIR"
  mkdir -p "$UNPACKED_DIR"
  cp -r "$work/." "$UNPACKED_DIR/"
  chmod -R u+w "$UNPACKED_DIR"
  echo "$UNPACKED_DIR"
fi

echo "$out"
