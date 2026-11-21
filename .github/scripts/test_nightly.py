#!/usr/bin/env python3
"""nightly.py's decisions: the version, whether anything changed, the notes."""

import datetime
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nightly  # noqa: E402

A = "a" * 40
B = "b" * 40
C = "c" * 40
DAY = datetime.date(2026, 11, 20)


class Version(unittest.TestCase):
    def test_the_next_patch_as_a_nightly(self):
        self.assertEqual(nightly.next_version((0, 2, 10), DAY, 42), "0.2.11-nightly.20261120.42")

    def test_the_latest_stable_is_the_highest_release(self):
        tags = ["v0.2.9", "v0.2.10", "v0.2.8", "v0.3.0-rc.1", "nightly", "v0.2.11-nightly.20261120.1"]
        self.assertEqual(nightly.latest_stable(tags), (0, 2, 10))
        with self.assertRaises(RuntimeError):
            nightly.latest_stable(["nightly"])

    def test_it_sorts_after_the_last_nightly_or_is_refused(self):
        last = "0.2.11-nightly.20261120.42"
        self.assertEqual(nightly.next_version((0, 2, 10), DAY, 43, last), "0.2.11-nightly.20261120.43")
        self.assertEqual(
            nightly.next_version((0, 2, 10), DAY + datetime.timedelta(days=1), 1, last), "0.2.11-nightly.20261121.1"
        )
        # A stable since: the next one's nightlies, newer still.
        self.assertEqual(nightly.next_version((0, 2, 11), DAY, 44, last), "0.2.12-nightly.20261120.44")
        with self.assertRaises(RuntimeError):
            nightly.next_version((0, 2, 10), DAY, 42, last)
        with self.assertRaises(RuntimeError):
            nightly.next_version((0, 2, 10), DAY - datetime.timedelta(days=1), 99, last)

    def test_numbers_sort_as_numbers(self):
        self.assertLess(nightly.nightly_key("0.2.11-nightly.20261120.9"), nightly.nightly_key("0.2.11-nightly.20261120.10"))
        self.assertIsNone(nightly.nightly_key("0.2.11"))
        self.assertIsNone(nightly.nightly_key("0.2.11-nightly.020261120.1"))


class BuiltTonight(unittest.TestCase):
    def test_a_later_try_skips_once_tonights_nightly_is_out(self):
        today = datetime.date(2026, 11, 21)
        tonight = nightly.next_version((0, 2, 11), today, 7)
        yesterday = nightly.next_version((0, 2, 11), today - datetime.timedelta(days=1), 7)
        self.assertIsNotNone(nightly.built_tonight({"version": tonight}, today))
        self.assertIsNone(nightly.built_tonight({"version": yesterday}, today))
        self.assertIsNone(nightly.built_tonight(None, today))
        self.assertIsNone(nightly.built_tonight({}, today))


class Decide(unittest.TestCase):
    last = {"version": "0.2.11-nightly.20261120.42", "desk_commit": A, "hub_ref": B}

    def test_nothing_changed_is_a_skip(self):
        bump, reason = nightly.decide(A, B, B, False, self.last)
        self.assertFalse(bump)
        self.assertIn("nothing changed", reason)
        # A hub that isn't ahead (hub.ref was set to a newer one by hand) is no change.
        self.assertIsNotNone(nightly.decide(A, B, C, False, self.last)[1])

    def test_a_newer_green_hub_is_bumped_to(self):
        self.assertEqual(nightly.decide(A, B, C, True, self.last), (True, None))

    def test_new_commits_on_main_are_built(self):
        self.assertEqual(nightly.decide(C, B, B, False, self.last), (False, None))
        # hub.ref moved by a person: a change too.
        self.assertEqual(nightly.decide(A, C, C, False, self.last), (False, None))

    def test_the_first_nightly_is_built(self):
        self.assertEqual(nightly.decide(A, B, None, False, None), (False, None))


class Notes(unittest.TestCase):
    def test_they_list_the_pull_requests_and_the_hub_commits(self):
        text = nightly.notes(
            "0.2.11-nightly.20261120.42", A, "nightly 0.2.11-nightly.20261119.41",
            ["Dialogs sit centred in the window (#352)", "Desk ships hub cccccccc: the newest hub"],
            B, C, [(C, "The boss decides one thing at a time (#400)")], "driftwerk/workforce-desk",
        )
        self.assertIn("## Changes since nightly 0.2.11-nightly.20261119.41", text)
        self.assertIn("- Dialogs sit centred in the window (#352)", text)
        self.assertIn("- The boss decides one thing at a time (#400) (cccccccc)", text)
        self.assertIn("Updates: Nightly", text)

    def test_the_same_hub_is_said(self):
        text = nightly.notes("0.2.11-nightly.20261120.42", A, "Desk 0.2.10", [], B, B, [], "o/r", "bump left out")
        self.assertIn("The same hub as Desk 0.2.10", text)
        self.assertIn("Nothing new in Desk itself", text)
        self.assertIn("## Worth a look", text)

    def test_the_bump_commit_reads_as_a_persons(self):
        msg = nightly.bump_message(B, C, ["one", "two"], "https://run")
        self.assertTrue(msg.startswith("Desk ships hub cccccccc: "))
        self.assertIn("- two", msg)


class Bump(unittest.TestCase):
    def test_it_moves_hub_ref_alone_never_vellev_ref(self):
        self.assertTrue(nightly.only_hub_ref(["hub.ref"]))
        self.assertFalse(nightly.only_hub_ref(["hub.ref", "vellev.ref"]))
        self.assertFalse(nightly.only_hub_ref(["vellev.ref"]))
        self.assertFalse(nightly.only_hub_ref([]))


class Releases(unittest.TestCase):
    def test_a_release_dry_run_doesnt_hold_up_the_nightly(self):
        self.assertTrue(nightly.is_dry_run({"display_title": "Release 0.2.11 (dry run)"}))
        self.assertFalse(nightly.is_dry_run({"display_title": "Release 0.2.11"}))
        self.assertFalse(nightly.is_dry_run({}))


class Skips(unittest.TestCase):
    def test_a_red_or_stuck_night_asks_for_a_person_and_nothing_to_do_doesnt(self):
        self.assertFalse(nightly.Skip("nothing changed").attention)
        self.assertTrue(nightly.Skip("CI red", attention=True).attention)


class Runs(unittest.TestCase):
    def test_the_newest_run_of_a_commit_counts(self):
        runs = [
            {"id": 1, "created_at": "2026-11-20T01:00:00Z", "conclusion": "failure"},
            {"id": 2, "created_at": "2026-11-20T02:00:00Z", "conclusion": "success"},
        ]
        self.assertEqual(nightly.newest_run(runs)["id"], 2)
        self.assertIsNone(nightly.newest_run([]))


def ci(conclusion, sha="x"):
    return {"status": "completed", "conclusion": conclusion, "html_url": f"https://ci/{sha}"}


class Main(unittest.TestCase):
    """Main moves all day: a night builds the newest green commit, never skips because it moved."""

    def settle(self, tips, runs, green=None, last=None):
        tips = iter(tips)
        tip = {}

        def git(*args, check=True):
            if args[0] == "rev-parse":
                return tip["now"]
            tip["now"] = next(tips)
            return ""

        with mock.patch.object(nightly, "git", git), \
             mock.patch.object(nightly, "wait_for_ci", lambda repo, sha, **kw: runs[sha]), \
             mock.patch.object(nightly, "green_sha", lambda repo, wf, branch: green), \
             mock.patch.object(nightly, "newer_than_last", lambda sha, last: not (last and last["desk_commit"] in (sha, B))):
            return nightly.settle("o/r", "main", last)

    def test_the_tip_that_passed_is_built(self):
        self.assertEqual(self.settle([B], {B: ci("success")}), (B, ""))

    def test_a_tip_a_newer_push_cancelled_gives_way_to_the_newer_tip(self):
        self.assertEqual(self.settle([A, B], {A: ci("cancelled"), B: ci("success")}), (B, ""))

    def test_a_red_tip_builds_the_newest_green_commit(self):
        sha, caveat = self.settle([C], {C: ci("failure")}, green=B)
        self.assertEqual(sha, B)
        self.assertIn("newest commit whose CI passed", caveat)

    def test_a_red_tip_with_nothing_newer_than_the_last_nightly_is_a_skip(self):
        with self.assertRaises(nightly.Skip) as e:
            self.settle([C], {C: ci("failure")}, green=B, last={"desk_commit": B})
        self.assertTrue(e.exception.attention)

    def test_a_tip_whose_ci_never_ran_is_a_skip_without_a_green_commit(self):
        with self.assertRaises(nightly.Skip):
            self.settle([C], {C: None})

    def test_the_newest_green_must_lead_on_from_the_last_nightly(self):
        def run(cmd, check=True):
            return mock.Mock(returncode=0 if cmd[-2:] == [A, B] else 1)

        with mock.patch.object(nightly, "run", run):
            self.assertTrue(nightly.newer_than_last(B, {"desk_commit": A}))
            self.assertFalse(nightly.newer_than_last(A, {"desk_commit": B}))
            self.assertFalse(nightly.newer_than_last(B, {"desk_commit": B}))
            self.assertTrue(nightly.newer_than_last(B, None))

    def test_a_bump_that_runs_out_of_time_is_left_out_not_the_night(self):
        def once(*a):
            raise nightly.Skip("ran out of time")

        with tempfile.TemporaryDirectory() as d, mock.patch.object(nightly, "bump_once", once), \
             mock.patch.object(nightly, "git", lambda *a, **k: ""):
            old = os.getcwd()
            os.chdir(d)
            try:
                self.assertEqual(nightly.bump("o/r", "main", A, B, [], "https://run"), (None, "ran out of time"))
            finally:
                os.chdir(old)

    def test_a_last_without_a_desk_commit_is_not_older_or_newer(self):
        self.assertFalse(nightly.newer_than_last(B, {"version": "x"}))

    def test_the_deadline_that_fired_is_the_one_named(self):
        runs = [{"status": "in_progress", "created_at": "t", "id": 1, "html_url": "u"}]
        with mock.patch.object(nightly, "ci_runs", lambda *a, **k: runs), \
             mock.patch.object(nightly, "BUMP_DEADLINE", 0), mock.patch.object(nightly, "CI_WAIT_MINUTES", 180):
            with self.assertRaises(nightly.Skip) as e:
                nightly.wait_for_ci("o/r", A, bump=True)
        self.assertIn("after 120 minutes", str(e.exception))
        with mock.patch.object(nightly, "ci_runs", lambda *a, **k: runs), \
             mock.patch.object(nightly, "DEADLINE", 0), mock.patch.object(nightly, "CI_WAIT_MINUTES", 180):
            with self.assertRaises(nightly.Skip) as e:
                nightly.wait_for_ci("o/r", A)
        self.assertIn("after 180 minutes", str(e.exception))

    def test_a_release_that_starts_meanwhile_holds_the_night(self):
        with mock.patch.object(nightly, "release_running", lambda repo: None):
            nightly.no_release_running("o/r")
        with mock.patch.object(nightly, "release_running", lambda repo: "https://run"):
            with self.assertRaises(nightly.Skip):
                nightly.no_release_running("o/r")

    def test_each_bump_try_has_its_own_work_branch(self):
        pushed = []

        def git(*args, check=True):
            return "HEAD~1" if args[0] == "rev-parse" else ("hub.ref" if args[0] == "diff" else "")

        def run(cmd, check=True, **kw):
            pushed.append(cmd)
            return mock.Mock(returncode=1)

        with tempfile.TemporaryDirectory() as d, mock.patch.object(nightly, "git", git), \
             mock.patch.object(nightly, "run", run), \
             mock.patch.object(nightly, "wait_for_ci", lambda *a, **k: ci("success")):
            old = os.getcwd()
            os.chdir(d)
            try:
                for attempt in (0, 1):
                    nightly.bump_once("o/r", "main", attempt, A, B, [], "https://run")
            finally:
                os.chdir(old)
        deletes = [c[-1] for c in pushed if "--delete" in c]
        self.assertEqual(len(set(deletes)), 2)

    def bump(self, once, fresh="hub"):
        results = iter(once)
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.object(nightly, "bump_once", lambda *a: next(results)), \
             mock.patch.object(nightly, "git", lambda *a, **k: ""):
            old = os.getcwd()
            os.chdir(d)
            try:
                pathlib.Path("hub.ref").write_text({"hub": A, "taken": C}[fresh] + "\n")
                return nightly.bump("o/r", "main", A, B, [], "https://run")
            finally:
                os.chdir(old)

    def test_a_bump_that_finds_main_moved_is_made_again_on_the_new_main(self):
        self.assertEqual(self.bump([(None, None), (C, None)]), (C, None))

    def test_a_bump_that_keeps_finding_main_moved_is_left_out_not_the_night(self):
        sha, why = self.bump([(None, None), (None, None)])
        self.assertIsNone(sha)
        self.assertIn("kept moving", why)

    def test_a_hub_main_took_on_its_own_needs_no_bump(self):
        self.assertEqual(self.bump([(None, None)], fresh="taken"), (None, ""))

    def test_a_bump_whose_ci_failed_is_left_out_at_once(self):
        self.assertEqual(self.bump([(None, "ci failed")]), (None, "ci failed"))


if __name__ == "__main__":
    unittest.main()
