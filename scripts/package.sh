#!/usr/bin/env bash
# Builds the release zip that users unzip and load unpacked.
# Usage: scripts/package.sh v0.3.1
set -euo pipefail

TAG="${1:?usage: scripts/package.sh <tag, e.g. v0.3.1>}"
VERSION="${TAG#v}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="side-heptabase"
DIST="$ROOT/dist"
STAGE="$DIST/$NAME"
ZIP="$DIST/$NAME-$TAG.zip"

MANIFEST_VERSION="$(node -p "require('$ROOT/manifest.json').version")"
if [ "$MANIFEST_VERSION" != "$VERSION" ]; then
  echo "manifest.json version is $MANIFEST_VERSION but the tag is $TAG" >&2
  echo "bump manifest.json before tagging" >&2
  exit 1
fi

rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"

# Tracked files only, so nothing untracked or ignored sneaks into the artifact.
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)"
echo "packaging HEAD ($COMMIT)"
git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$STAGE"

# Everything below is for working on the extension, not for running it.
rm -rf "$STAGE/.github" "$STAGE/.gitignore" "$STAGE/.claude" "$STAGE/.ryugi" \
       "$STAGE/docs" "$STAGE/tests" "$STAGE/scripts" "$STAGE/assets" "$STAGE/AGENTS.md"

node "$ROOT/scripts/verify-package.mjs" "$STAGE"

# Zip keeps a top-level folder so unzipping never scatters files into Downloads.
(cd "$DIST" && zip -qr -X "$(basename "$ZIP")" "$NAME")

echo
echo "built $(basename "$ZIP") ($(du -h "$ZIP" | cut -f1))"
