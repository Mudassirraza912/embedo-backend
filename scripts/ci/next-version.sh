#!/usr/bin/env bash
# Computes the version of the build being deployed. Used by .github/workflows/ci-cd.yml.
#
#   Usage: scripts/ci/next-version.sh <production|development>
#   Prints KEY=VALUE lines for $GITHUB_OUTPUT: version, tag, channel.
#
# Scheme: MAJOR.MINOR.BUILD
#   MAJOR.MINOR  from package.json "version" (bump it by hand for a big release; BUILD restarts at 0)
#   BUILD        one more than the newest production tag vMAJOR.MINOR.N (0 when there is none)
# Production deploys get vMAJOR.MINOR.BUILD and are tagged + released on GitHub after a successful
# deploy. Development deploys get MAJOR.MINOR.BUILD-dev.<run number>: a pre-release of the next
# production build, never tagged, so dev never uses up a production number.
# Needs the repository's tags (actions/checkout with fetch-depth: 0).
set -euo pipefail

channel="${1:?usage: next-version.sh <production|development>}"
base=$(node -p "require('./package.json').version")
major_minor=$(echo "$base" | cut -d. -f1,2)
escaped=${major_minor//./\\.}

last=$(git tag --list "v${major_minor}.*" | grep -E "^v${escaped}\.[0-9]+$" | sort -V | tail -n 1 || true)
if [ -n "$last" ]; then
  build=$(( ${last##*.} + 1 ))
else
  build=0
fi

version="${major_minor}.${build}"
case "$channel" in
  production)
    echo "version=${version}"
    echo "tag=v${version}"
    ;;
  development)
    echo "version=${version}-dev.${GITHUB_RUN_NUMBER:-0}"
    echo "tag="
    ;;
  *)
    echo "unknown channel: $channel" >&2
    exit 1
    ;;
esac
echo "channel=${channel}"
