import json
import os
import sys
import tempfile
import unittest
import subprocess
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from libvirt_mcp.commands import CommandRunner, MAX_DIAGNOSTIC_CHARS
from libvirt_mcp.errors import LifecycleError


class CommandTests(unittest.TestCase):
    def test_argv_execution_preserves_arguments_without_shell_interpretation(self):
        marker = "value; exit 99"
        result = CommandRunner().run([sys.executable, "-c", "import sys; print(sys.argv[1])", marker], timeout_seconds=5)
        self.assertEqual(0, result.returncode)
        self.assertEqual(marker, result.stdout.strip())

    def test_missing_command_has_machine_readable_error(self):
        with self.assertRaises(LifecycleError) as caught:
            CommandRunner().run(["/definitely/not/a/command"], timeout_seconds=1)
        self.assertEqual("command_unavailable", caught.exception.code)
        self.assertEqual("/definitely/not/a/command", caught.exception.details["argv"][0])

    def test_timeout_reports_ambiguous_side_effect(self):
        with self.assertRaises(LifecycleError) as caught:
            CommandRunner().run([sys.executable, "-c", "import time; time.sleep(1)"], timeout_seconds=0.01)
        self.assertEqual("command_timeout", caught.exception.code)
        self.assertTrue(caught.exception.details["side_effect_unknown"])

    def test_timeout_preserves_normalized_bounded_partial_output_including_bytes(self):
        expired = subprocess.TimeoutExpired(
            cmd=["slow"],
            timeout=1,
            output=b"stdout-\xff" + (b"x" * (MAX_DIAGNOSTIC_CHARS * 2)),
            stderr="stderr-" + ("y" * (MAX_DIAGNOSTIC_CHARS * 2)),
        )
        with patch("libvirt_mcp.commands.subprocess.run", side_effect=expired), self.assertRaises(LifecycleError) as caught:
            CommandRunner().run(["slow"], timeout_seconds=1)
        details = caught.exception.details
        self.assertTrue(details["side_effect_unknown"])
        self.assertIsInstance(details["stdout"], str)
        self.assertIsInstance(details["stderr"], str)
        self.assertIn("stdout-\ufffd", details["stdout"])
        self.assertIn("stderr-", details["stderr"])
        self.assertLessEqual(len(details["stdout"]), MAX_DIAGNOSTIC_CHARS)
        self.assertLessEqual(len(details["stderr"]), MAX_DIAGNOSTIC_CHARS)
        self.assertTrue(details["stdout"].endswith("...[truncated]"))

    def test_timeout_must_be_finite(self):
        for timeout in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(timeout=timeout), self.assertRaises(LifecycleError) as caught:
                CommandRunner().run([sys.executable, "-c", "pass"], timeout_seconds=timeout)
            self.assertEqual("invalid_argument", caught.exception.code)

    def test_other_os_launch_failures_are_structured(self):
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(LifecycleError) as caught:
            CommandRunner().run([tmp], timeout_seconds=1)
        self.assertEqual("command_launch_failed", caught.exception.code)
        self.assertEqual(tmp, caught.exception.details["argv"][0])
        self.assertIsInstance(caught.exception.details["errno"], int)

    def test_child_locale_is_c_while_unrelated_parent_environment_is_preserved(self):
        script = (
            "import json, os; "
            "print(json.dumps({key: os.environ.get(key) for key in "
            "['LC_ALL', 'LANG', 'LIBVIRT_TEST_SENTINEL']}))"
        )
        parent = {
            "LC_ALL": "fr_FR.UTF-8",
            "LANG": "de_DE.UTF-8",
            "LIBVIRT_TEST_SENTINEL": "preserved",
        }
        with patch.dict(os.environ, parent, clear=False):
            result = CommandRunner().run([sys.executable, "-c", script], timeout_seconds=5)
        child = json.loads(result.stdout)
        self.assertEqual("C", child["LC_ALL"])
        self.assertEqual("de_DE.UTF-8", child["LANG"])
        self.assertEqual("preserved", child["LIBVIRT_TEST_SENTINEL"])


if __name__ == "__main__":
    unittest.main()
