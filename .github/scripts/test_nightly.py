#!/usr/bin/env python3
"""nightly.py's decisions: the version, whether anything changed, the notes."""

import datetime
import os
import sys
import unittest

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
        self.assertIn("## Left out", text)

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


if __name__ == "__main__":
    unittest.main()
