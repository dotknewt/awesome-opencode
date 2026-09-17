from __future__ import annotations

import math
import os
import subprocess
from dataclasses import dataclass
from typing import Sequence

from .errors import LifecycleError


MAX_DIAGNOSTIC_CHARS = 65536
TRUNCATION_MARKER = "...[truncated]"


def _bounded_text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    text = value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value)
    if len(text) <= MAX_DIAGNOSTIC_CHARS:
        return text
    return text[: MAX_DIAGNOSTIC_CHARS - len(TRUNCATION_MARKER)] + TRUNCATION_MARKER


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


class CommandRunner:
    """Execute argv-only subprocesses with a mandatory finite timeout."""

    def run(self, argv: Sequence[str], timeout_seconds: float = 30) -> CommandResult:
        if (
            not argv
            or isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not math.isfinite(timeout_seconds)
            or timeout_seconds < 0
        ):
            raise LifecycleError("invalid_argument", "argv and a finite non-negative timeout are required")
        try:
            environment = os.environ.copy()
            environment["LC_ALL"] = "C"
            result = subprocess.run(
                list(argv),
                capture_output=True,
                text=True,
                check=False,
                timeout=timeout_seconds,
                shell=False,
                env=environment,
            )
        except FileNotFoundError as exc:
            raise LifecycleError(
                "command_unavailable", f"required command is unavailable: {argv[0]}", {"argv": list(argv)}
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise LifecycleError(
                "command_timeout",
                "external command exceeded its bounded execution time",
                {
                    "argv": list(argv),
                    "timeout_seconds": timeout_seconds,
                    "stdout": _bounded_text(exc.stdout),
                    "stderr": _bounded_text(exc.stderr),
                    "side_effect_unknown": True,
                },
            ) from exc
        except OSError as exc:
            raise LifecycleError(
                "command_launch_failed",
                "external command could not be launched",
                {
                    "argv": list(argv),
                    "errno": exc.errno,
                    "strerror": exc.strerror or str(exc),
                    "side_effect_unknown": False,
                },
            ) from exc
        return CommandResult(result.returncode, result.stdout, result.stderr)
