#!/usr/bin/env python3
"""Plans tonight's nightly build of Desk (nightly.yml), or says why there is none.

In order:
  1. Skips while a stable release (release.yml) is running.
  2. Reads the last nightly from the nightly feed (latest-nightly.json on the
     `nightly` release): its version, and the Desk commit and hub ref it was built from.
  3. Finds the newest hub commit (driftwerk/workforce main) whose checks (pr-check.yml)
     passed. When it is ahead of hub.ref, the bump is committed on a branch, Desk's CI is
     run on it (workflow_dispatch: pushes made with the job's token start no workflow),
     and main is fast-forwarded to it once that CI is green. A bump whose CI fails is left
     out, and said; main never gets a red bump.
  4. Skips when neither Desk's main nor hub.ref changed since the last nightly.
  5. Gate: Desk's CI must have passed at the exact commit to be built.
  6. The version: the latest stable's next patch, as a nightly
     (0.2.10 -> 0.2.11-nightly.20261120.42, the date in UTC and this workflow's run number).
  7. The notes: the pull requests merged since the last nightly (their squash commits'
     subjects) and the hub commits brought in.

Writes `build`, `version`, `ref`, `hub_ref`, `reason` and `attention` to $GITHUB_OUTPUT, the
notes to notes/notes.md, and what it decided to the job summary. A dry run commits and
pushes nothing: it builds the commit as it is, with the hub it would bump to (`hub_ref`).
"""

import datetime
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

HUB_REPO = os.environ.get("HUB_REPO", "driftwerk/workforce")
HUB_CHECK = os.environ.get("HUB_CHECK", "pr-check.yml")
CI = "ci.yml"
RELEASE = "release.yml"
CI_WAIT_MINUTES = int(os.environ.get("CI_WAIT_MINUTES", "180"))
NIGHTLY = re.compile(r"^(\d+)\.(\d+)\.(\d+)-nightly\.([1-9]\d{7})\.([1-9]\d*)$")
STABLE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
SHA = re.compile(r"^[0-9a-f]{40}$")


class Skip(Exception):
    """No nightly tonight, and why: not a failure."""


# What a person should look at even when the night goes well: a hub bump
# whose CI failed. The failure issue (nightly-issue.sh) carries it.
ATTENTION = []


# ── Pure parts (test_nightly.py) ───────────────────────────────────────────


def stable_version(tag):
    """(major, minor, patch) of a stable release's tag, or None for anything else."""
    m = STABLE.match(tag.strip())
    return tuple(int(x) for x in m.groups()) if m else None


def latest_stable(tags):
    """The highest stable version among release tags, as (major, minor, patch)."""
    versions = [v for v in (stable_version(t) for t in tags) if v]
    if not versions:
        raise RuntimeError("no stable release to build a nightly after")
    return max(versions)


def nightly_key(version):
    """A nightly's version as a tuple that sorts as semver does, or None."""
    m = NIGHTLY.match(version)
    return tuple(int(x) for x in m.groups()) if m else None


def next_version(stable, today, run_number, last=None):
    """The nightly after `stable` (major, minor, patch), built on `today` (a date) by run
    `run_number`: the next patch's pre-release, which sorts after `stable` and before that
    patch's own release. Refuses one that wouldn't be newer than the `last` nightly."""
    major, minor, patch = stable
    version = f"{major}.{minor}.{patch + 1}-nightly.{today:%Y%m%d}.{int(run_number)}"
    if last and nightly_key(last) and nightly_key(version) <= nightly_key(last):
        raise RuntimeError(f"{version} wouldn't be newer than the last nightly, {last}")
    return version


def short(sha):
    return sha[:8]


def bump_message(hub_from, hub_to, hub_subjects, run_url):
    """The hub.ref bump's commit message, as a person writes one (docs/RELEASING.md)."""
    lines = [f"Desk ships hub {short(hub_to)}: the newest hub whose checks passed, for tonight's nightly", ""]
    lines.append(f"Hub commits from {short(hub_from)} to {short(hub_to)}:")
    lines += [f"- {s}" for s in hub_subjects[:40]]
    if len(hub_subjects) > 40:
        lines.append(f"- and {len(hub_subjects) - 40} more")
    lines += ["", f"Committed by the nightly build: {run_url}"]
    return "\n".join(lines)


def notes(version, sha, since_label, changes, hub_from, hub_to, hub_commits, repo, attention=""):
    """The nightly's release notes, in Markdown."""
    out = [
        f"Desk {version}: a nightly build of `main` at {short(sha)}. Only a Desk set to "
        "**Updates: Nightly** (Settings → Help) installs it.",
        "",
        f"## Changes since {since_label}",
        "",
    ]
    out += [f"- {c}" for c in changes] or ["- Nothing new in Desk itself."]
    out += ["", "## Hub", ""]
    if hub_from == hub_to:
        out.append(f"The same hub as {since_label}: [{short(hub_to)}](https://github.com/{HUB_REPO}/commit/{hub_to}).")
    else:
        out.append(
            f"[{short(hub_from)}…{short(hub_to)}](https://github.com/{HUB_REPO}/compare/{hub_from}...{hub_to}):"
        )
        out.append("")
        out += [f"- {subject} ({short(c)})" for c, subject in hub_commits] or ["- (no commits listed)"]
    if attention:
        out += ["", "## Left out", "", attention]
    out += ["", f"Built from https://github.com/{repo}/commit/{sha}."]
    return "\n".join(out) + "\n"


def decide(head, hub_now, hub_candidate, hub_ahead, last):
    """Whether there is anything to build: (bump, reason to skip or None)."""
    bump = bool(hub_candidate) and hub_candidate != hub_now and hub_ahead
    if last and last.get("desk_commit") == head and last.get("hub_ref") == hub_now and not bump:
        return False, f"nothing changed since the last nightly, {last.get('version')}: no new commits on main and no newer hub"
    return bump, None


def newest_run(runs):
    """The newest of a commit's workflow runs (a rerun or a dispatch after a push)."""
    return max(runs, key=lambda r: (r.get("created_at", ""), r.get("id", 0)), default=None)


# ── GitHub and git ─────────────────────────────────────────────────────────


def run(cmd, check=True, **kw):
    result = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if check and result.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:5])} failed: {result.stderr.strip()[-800:]}")
    return result


def gh_api(path, check=True):
    result = run(["gh", "api", "-H", "Accept: application/vnd.github+json", path], check=check)
    return json.loads(result.stdout) if result.returncode == 0 and result.stdout.strip() else None


def git(*args, check=True):
    return run(["git", *args], check=check).stdout.strip()


def feed(releases_repo):
    """The last nightly's feed, or None before the first."""
    url = f"https://github.com/{releases_repo}/releases/download/nightly/latest-nightly.json"
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def release_running(repo):
    for status in ("in_progress", "queued", "waiting", "pending", "requested"):
        runs = gh_api(f"repos/{repo}/actions/workflows/{RELEASE}/runs?status={status}&per_page=5")
        if runs and runs.get("workflow_runs"):
            return runs["workflow_runs"][0]["html_url"]
    return None


def hub_green():
    """The newest hub commit on main whose checks passed."""
    runs = gh_api(
        f"repos/{HUB_REPO}/actions/workflows/{HUB_CHECK}/runs?branch=main&event=push&status=success&per_page=1"
    )
    found = (runs or {}).get("workflow_runs") or []
    return found[0]["head_sha"] if found else None


def hub_compare(base, head):
    """How `head` stands to `base` on the hub ("ahead", "behind", ...), and its commits."""
    c = gh_api(f"repos/{HUB_REPO}/compare/{base}...{head}")
    commits = [(x["sha"], x["commit"]["message"].splitlines()[0]) for x in c.get("commits", [])]
    return c["status"], commits


def ci_runs(repo, sha):
    runs = gh_api(f"repos/{repo}/actions/workflows/{CI}/runs?head_sha={sha}&per_page=20")
    return (runs or {}).get("workflow_runs") or []


def wait_for_ci(repo, sha, appear_minutes=15):
    """Desk's CI at exactly `sha`, waited for while it runs: its run, or None if none came."""
    deadline = time.time() + CI_WAIT_MINUTES * 60
    appear = time.time() + appear_minutes * 60
    while True:
        latest = newest_run(ci_runs(repo, sha))
        if latest and latest["status"] == "completed":
            return latest
        if not latest and time.time() > appear:
            return None
        if time.time() > deadline:
            raise Skip(f"Desk's CI at {short(sha)} was still running after {CI_WAIT_MINUTES} minutes: {latest['html_url']}")
        time.sleep(60)


def gate(repo, sha):
    """Desk's CI passed at `sha`, or Skip saying why not."""
    latest = wait_for_ci(repo, sha, appear_minutes=0)
    if not latest:
        raise Skip(f"Desk's CI never ran at {short(sha)}, so it isn't built")
    if latest["conclusion"] != "success":
        raise Skip(f"Desk's CI at {short(sha)} ended {latest['conclusion']}, so it isn't built: {latest['html_url']}")


def bump(repo, hub_from, hub_to, hub_commits, run_url):
    """Commits hub.ref = `hub_to` on a branch, runs Desk's CI there, and fast-forwards main
    to it once green. Returns the new main commit, or (None, why) when the bump is left out."""
    branch = f"nightly/hub-{short(hub_to)}-{os.environ.get('GITHUB_RUN_ID', 'local')}"
    with open("hub.ref", "w") as f:
        f.write(hub_to + "\n")
    git("-c", "user.name=github-actions[bot]",
        "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "commit", "-q", "-m", bump_message(hub_from, hub_to, [s for _, s in hub_commits], run_url), "hub.ref")
    sha = git("rev-parse", "HEAD")
    git("push", "-q", "origin", f"HEAD:refs/heads/{branch}")
    try:
        run(["gh", "workflow", "run", CI, "--repo", repo, "--ref", branch])
        latest = wait_for_ci(repo, sha)
        if not latest:
            return None, f"Desk's CI didn't start for the hub bump to {short(hub_to)}"
        if latest["conclusion"] != "success":
            return None, (f"Desk's CI failed with hub {short(hub_to)}, so the bump was left out: "
                          f"{latest['html_url']}")
        pushed = run(["git", "push", "-q", "origin", f"{sha}:refs/heads/main"], check=False)
        if pushed.returncode != 0:
            raise Skip(f"main moved while Desk's CI checked the hub bump to {short(hub_to)}; "
                       "the next nightly takes both")
        return sha, None
    finally:
        run(["git", "push", "-q", "origin", "--delete", branch], check=False)


def output(**kw):
    path = os.environ.get("GITHUB_OUTPUT")
    lines = []
    for k, v in kw.items():
        v = str(v).replace("\n", " ")
        lines.append(f"{k}={v}")
    if path:
        with open(path, "a") as f:
            f.write("\n".join(lines) + "\n")
    print("\n".join(lines))


def summary(text):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write(text + "\n")
    print(text)


def plan():
    repo = os.environ["GITHUB_REPOSITORY"]
    releases_repo = os.environ.get("RELEASES_REPO") or repo
    dry = os.environ.get("DRY_RUN") == "true"
    branch = os.environ.get("GITHUB_REF_NAME", "")
    default = os.environ.get("DEFAULT_BRANCH", "main")
    run_url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{repo}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"
    if not dry and branch != default:
        raise RuntimeError(f"a nightly is published from {default} only; this run is on {branch}: use dry_run")

    running = release_running(repo)
    if running:
        raise Skip(f"a release is running: {running}")

    last = feed(releases_repo)
    head = git("rev-parse", "HEAD")
    hub_now = open("hub.ref").read().strip()
    if not SHA.match(hub_now):
        raise RuntimeError(f"hub.ref isn't a commit: {hub_now!r}")
    candidate = hub_green()
    ahead, hub_commits = False, []
    if candidate and candidate != hub_now:
        status, hub_commits = hub_compare(hub_now, candidate)
        ahead = status == "ahead"
        if not ahead:
            print(f"hub {short(candidate)} is {status} of hub.ref {short(hub_now)}: hub.ref stays")
    want_bump, reason = decide(head, hub_now, candidate, ahead, last)
    if reason:
        raise Skip(reason)

    sha, hub_ref, override, attention = head, hub_now, "", ""
    if want_bump:
        if dry:
            print(f"dry run: would commit hub.ref {short(candidate)} on a branch, run Desk's CI on it, "
                  f"and fast-forward {default} to it once green")
            print(bump_message(hub_now, candidate, [s for _, s in hub_commits], run_url))
            hub_ref, override = candidate, candidate
        else:
            bumped, why = bump(repo, hub_now, candidate, hub_commits, run_url)
            if bumped:
                sha, hub_ref = bumped, candidate
            else:
                attention = why
                ATTENTION.append(why)
                print(f"::warning::{why}")
                # Without the bump: only if Desk itself changed since the last nightly.
                git("reset", "-q", "--hard", head)
                if last and last.get("desk_commit") == head and last.get("hub_ref") == hub_now:
                    raise Skip(f"{why}; nothing else changed since {last.get('version')}")

    # The bump was gated as it was made; anything else is gated here.
    if sha == head:
        gate(repo, sha)

    tags = [r["tag_name"] for r in gh_api(f"repos/{releases_repo}/releases?per_page=100")
            if not r["prerelease"] and not r["draft"]]
    stable = latest_stable(tags)
    today = datetime.datetime.now(datetime.timezone.utc).date()
    version = next_version(stable, today, os.environ.get("GITHUB_RUN_NUMBER", "1"),
                           last.get("version") if last else None)

    # Since the last nightly; before the first, since the latest stable.
    stable_tag = "v{}.{}.{}".format(*stable)
    if last and last.get("desk_commit"):
        since, since_label, hub_from = last["desk_commit"], f"nightly {last.get('version')}", last.get("hub_ref") or hub_now
    else:
        since = git("rev-list", "-n1", stable_tag, check=False) or ""
        since_label = f"Desk {stable_tag[1:]}"
        hub_from = git("show", f"{since}:hub.ref", check=False).strip() if since else hub_now
    changes = []
    if since and run(["git", "merge-base", "--is-ancestor", since, sha], check=False).returncode == 0:
        changes = [s for s in git("log", "--first-parent", "--format=%s", f"{since}..{sha}").splitlines() if s]
    elif since:
        changes = [f"(the commits since {since_label} couldn't be listed: {short(since)} isn't behind {short(sha)})"]
    hub_from = hub_from if SHA.match(hub_from or "") else hub_ref
    brought = []
    if hub_from != hub_ref:
        _, brought = hub_compare(hub_from, hub_ref)
    os.makedirs("notes", exist_ok=True)
    with open("notes/notes.md", "w") as f:
        f.write(notes(version, sha, since_label, changes, hub_from, hub_ref, brought, repo, attention))

    output(build="true", version=version, ref=sha, hub_ref=override, reason="", attention=attention)
    summary(f"### Nightly {version}{' (dry run)' if dry else ''}\n\n"
            f"Desk {short(sha)}, hub {short(hub_ref)}"
            f"{' (the bump it would commit)' if override else ''}.\n\n"
            + open("notes/notes.md").read())


def main():
    try:
        plan()
    except Skip as e:
        output(build="false", version="", ref="", hub_ref="", reason=str(e), attention=" ".join(ATTENTION))
        summary(f"### No nightly tonight\n\n{e}.")
        print(f"::notice::No nightly tonight: {e}")


if __name__ == "__main__":
    sys.exit(main())
