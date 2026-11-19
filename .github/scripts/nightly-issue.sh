#!/usr/bin/env bash
# Keeps one open issue while the nightly build needs a person: opened (or
# commented on) when a night fails or leaves a hub bump out, closed again by
# the next night that goes well.
#
#   nightly-issue.sh failed|attention|ok "what happened"

set -euo pipefail

state=${1:?failed, attention or ok}
what=${2:-}
title="Nightly build needs attention"
label="nightly"
run="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"

gh label create "$label" --color FBCA04 --description "The nightly build (nightly.yml)" --force >/dev/null

existing=$(gh issue list --label "$label" --state open --json number --jq '.[0].number // empty')

if [ "$state" = ok ]; then
    if [ -n "$existing" ]; then
        gh issue close "$existing" --comment "Tonight's nightly went well: $run"
    fi
    exit 0
fi

body=$(mktemp)
{
    echo "$what"
    echo
    echo "Run: $run"
} > "$body"

if [ -z "$existing" ]; then
    gh issue create --title "$title" --label "$label" --body-file "$body"
else
    gh issue comment "$existing" --body-file "$body"
fi
