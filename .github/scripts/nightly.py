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
  5. Gate: Desk's CI must have passed at the exact commit to be built. That is main's
     tip, taken afresh (it moves all day); when its CI was superseded by a newer push, the
     newer tip; when it is red, the newest commit of main whose CI passed, if that is
     newer than the last nightly. A bump that finds main moved is made again on the new
     main (twice at most) and otherwise left for the next night, never the night itself.
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
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

HUB_REPO = os.environ.get("HUB_REPO", "driftwerk/workforce")
HUB_CHECK = os.environ.get("HUB_CHECK", "pr-check.yml")
CI = "ci.yml"
# The Linux backend's smoke test, which a person's hub.ref pull request runs too.
BACKEND = "backend.yml"
RELEASE = "release.yml"
BUMP_TRIES = 2
TIP_TRIES = 4
CI_WAIT_MINUTES = int(os.environ.get("CI_WAIT_MINUTES", "180"))
NIGHTLY = re.compile(r"^(\d+)\.(\d+)\.(\d+)-nightly\.([1-9]\d{7})\.([1-9]\d*)$")
STABLE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
SHA = re.compile(r"^[0-9a-f]{40}$")


class Skip(Exception):
    """No nightly tonight, and why. `attention`: a person should look (CI red or stuck,
    main moving under a bump), as against nothing to do (nothing changed, a release running)."""

    def __init__(self, reason, attention=False):
        super().__init__(reason)
        self.attention = attention


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


def only_hub_ref(changed):
    """The bump's commit changes hub.ref and nothing else: vellev.ref above all, which
    is held where it is (docs/RELEASING.md) and is never the nightly's to move."""
    return [p for p in changed if p] == ["hub.ref"]


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


def is_dry_run(run):
    """A Release run that publishes nothing (its title says so: release.yml's run-name)."""
    return "(dry run)" in (run.get("display_title") or "")


def release_running(repo):
    """A Release run under way that will publish, if any: a dry run doesn't count."""
    for status in ("in_progress", "queued", "waiting", "pending", "requested"):
        runs = gh_api(f"repos/{repo}/actions/workflows/{RELEASE}/runs?status={status}&per_page=20")
        for r in (runs or {}).get("workflow_runs") or []:
            if not is_dry_run(r):
                return r["html_url"]
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


def ci_runs(repo, sha, workflow=CI):
    runs = gh_api(f"repos/{repo}/actions/workflows/{workflow}/runs?head_sha={sha}&per_page=20")
    return (runs or {}).get("workflow_runs") or []


# One deadline for all of tonight's waiting, so a failed bump's wait and the gate after it
# end inside the job's timeout.
DEADLINE = time.time() + CI_WAIT_MINUTES * 60


def wait_for_ci(repo, sha, appear_minutes=15, workflow=CI):
    """`workflow` (Desk's CI) at exactly `sha`, waited for while it runs: its run, or None
    if none came."""
    appear = time.time() + appear_minutes * 60
    while True:
        latest = newest_run(ci_runs(repo, sha, workflow))
        if latest and latest["status"] == "completed":
            return latest
        if not latest and time.time() > appear:
            return None
        if time.time() > DEADLINE:
            where = latest["html_url"] if latest else "no run yet"
            raise Skip(f"{workflow} at {short(sha)} was still running after {CI_WAIT_MINUTES} minutes: {where}",
                       attention=True)
        time.sleep(60)


def gate(repo, sha):
    """Desk's CI passed at `sha`, or Skip saying why not."""
    latest = wait_for_ci(repo, sha, appear_minutes=5)
    if not latest:
        raise Skip(f"Desk's CI never ran at {short(sha)}, so it isn't built", attention=True)
    if latest["conclusion"] != "success":
        raise Skip(f"Desk's CI at {short(sha)} ended {latest['conclusion']}, so it isn't built: {latest['html_url']}",
                   attention=True)


def newest_green(repo, branch):
    """The newest commit pushed to `branch` whose Desk CI passed, or None."""
    runs = gh_api(f"repos/{repo}/actions/workflows/{CI}/runs?branch={branch}&event=push&status=success&per_page=1")
    found = (runs or {}).get("workflow_runs") or []
    return found[0]["head_sha"] if found else None


def settle(repo, branch, last):
    """The commit of `branch` to build, and what a person should know of it: its tip, taken
    afresh, once Desk's CI passed there (a tip whose run a newer push cancelled gives way
    to the newer tip); a red or unbuilt tip gives way to the newest green commit when that
    is newer than the last nightly's."""
    tip, problem = None, ""
    for _ in range(TIP_TRIES):
        git("fetch", "-q", "origin", branch)
        tip = git("rev-parse", f"origin/{branch}")
        latest = wait_for_ci(repo, tip, appear_minutes=5)
        if latest and latest["conclusion"] == "success":
            return tip, ""
        if not (latest and latest["conclusion"] == "cancelled"):
            problem = (f"Desk's CI ended {latest['conclusion']} at {short(tip)}: {latest['html_url']}" if latest
                       else f"Desk's CI never ran at {short(tip)}")
            break
        problem = f"Desk's CI at {short(tip)} was cancelled: {latest['html_url']}"
    green = newest_green(repo, branch)
    if green and green != tip and not (last and last.get("desk_commit") == green):
        return green, f"{problem}, so {short(green)}, the newest commit whose CI passed, is built."
    raise Skip(f"{problem}, so it isn't built", attention=True)


def bump(repo, hub_from, hub_to, hub_commits, run_url):
    """Commits hub.ref = `hub_to` on a branch, runs Desk's CI there, and fast-forwards main
    to it once green. When main moved meanwhile it is done again on the new main, up to
    BUMP_TRIES times. Returns the new main commit, or (None, why) when the bump is left out
    (why is empty when main took the hub on its own)."""
    for _ in range(BUMP_TRIES):
        sha, why = bump_once(repo, hub_from, hub_to, hub_commits, run_url)
        if sha or why:
            return sha, why
        git("fetch", "-q", "origin", "main")
        git("reset", "-q", "--hard", "origin/main")
        if pathlib.Path("hub.ref").read_text().strip() != hub_from:
            return None, ""
    return None, f"main kept moving while Desk's CI checked the hub bump to {short(hub_to)}; the next nightly takes it"


def bump_once(repo, hub_from, hub_to, hub_commits, run_url):
    """One try of the bump: (commit, None) when main is at it, (None, why) when it is left
    out, and (None, None) when main moved while its CI ran."""
    branch = f"nightly/hub-{short(hub_to)}-{os.environ.get('GITHUB_RUN_ID', 'local')}"
    with open("hub.ref", "w") as f:
        f.write(hub_to + "\n")
    git("-c", "user.name=github-actions[bot]",
        "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "commit", "-q", "-m", bump_message(hub_from, hub_to, [s for _, s in hub_commits], run_url), "hub.ref")
    sha = git("rev-parse", "HEAD")
    changed = git("diff", "--name-only", "HEAD~1", "HEAD").splitlines()
    if not only_hub_ref(changed):
        raise RuntimeError(f"the hub bump would change {changed}, not hub.ref alone")
    git("push", "-q", "origin", f"HEAD:refs/heads/{branch}")
    try:
        # CI, and the backend's smoke test a person's hub.ref pull request runs too.
        for workflow in (CI, BACKEND):
            run(["gh", "workflow", "run", workflow, "--repo", repo, "--ref", branch])
        for workflow in (CI, BACKEND):
            latest = wait_for_ci(repo, sha, workflow=workflow)
            if not latest:
                return None, f"{workflow} didn't start for the hub bump to {short(hub_to)}"
            if latest["conclusion"] != "success":
                return None, (f"{workflow} failed with hub {short(hub_to)}, so the bump was left out: "
                              f"{latest['html_url']}")
        pushed = run(["git", "push", "-q", "origin", f"{sha}:refs/heads/main"], check=False)
        return (sha, None) if pushed.returncode == 0 else (None, None)
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
    default = os.environ.get("DEFAULT_BRANCH") or "main"
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
            elif why:
                attention = why
                ATTENTION.append(why)
                print(f"::warning::{why}")

    # The bump was gated as it was made; anything else is gated here, on main's tip as it
    # is now. A dry run, on a branch of its own, gates the commit it is on.
    if sha == head and dry:
        gate(repo, sha)
    elif sha == head:
        sha, caveat = settle(repo, default, last)
        hub_ref = git("show", f"{sha}:hub.ref").strip()
        if caveat:
            attention = " ".join(x for x in (attention, caveat) if x)
            ATTENTION.append(caveat)
            print(f"::warning::{caveat}")
        if last and last.get("desk_commit") == sha and last.get("hub_ref") == hub_ref:
            raise Skip(f"nothing changed since the last nightly, {last.get('version')}"
                       + (f"; {attention}" if attention else ""))

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
        if e.attention:
            ATTENTION.append(f"No nightly tonight: {e}.")
        output(build="false", version="", ref="", hub_ref="", reason=str(e), attention=" ".join(ATTENTION))
        summary(f"### No nightly tonight\n\n{e}.")
        print(f"::notice::No nightly tonight: {e}")


if __name__ == "__main__":
    sys.exit(main())
