from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import uuid
from pathlib import Path
from typing import Iterator

from .errors import LifecycleError


SCHEMA_VERSION = 1
IDENTIFIER = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})$")


class Store:
    """Atomic host-local ownership registry, journal, and process lock."""

    def __init__(self, root: Path):
        self.root = Path(root).expanduser().absolute()
        self.root.mkdir(parents=True, exist_ok=True)
        self.registry_path = self.root / "registry.json"
        self.journal_path = self.root / "operation.json"
        self.lock_path = self.root / ".lock"

    def load(self) -> dict:
        if not self.registry_path.exists():
            return {"schema_version": SCHEMA_VERSION, "templates": {}, "vms": {}}
        try:
            data = json.loads(self.registry_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise LifecycleError("store_corrupt", "ownership registry cannot be read") from exc
        if data.get("schema_version") != SCHEMA_VERSION:
            raise LifecycleError(
                "unsupported_store_schema",
                "ownership registry schema is unsupported",
                {"found": data.get("schema_version"), "supported": SCHEMA_VERSION},
            )
        data.setdefault("templates", {})
        data.setdefault("vms", {})
        return data

    def _atomic_json(self, path: Path, data: dict) -> None:
        temporary = path.with_name(path.name + ".tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        self._fsync_directory(path.parent)

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        descriptor = os.open(path, flags)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    @staticmethod
    def _fsync_file(path: Path) -> None:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _managed_ancestors(self, directory: Path) -> list[Path]:
        ancestors = []
        current = directory.absolute()
        root = self.root.absolute()
        while True:
            ancestors.append(current)
            if current == root:
                return ancestors
            if root not in current.parents:
                raise LifecycleError("unsafe_path", "persistence path escapes the storage root")
            current = current.parent

    def persist_paths(self, paths) -> None:
        """Fsync managed resource files and every managed directory entry."""
        directories = set()
        for value in paths:
            path = Path(value)
            self._fsync_file(path)
            directories.update(self._managed_ancestors(path.parent))
        for directory in sorted(directories, key=lambda item: len(item.parts), reverse=True):
            self._fsync_directory(directory)

    def persist_directory(self, directory: Path) -> None:
        """Fsync a changed managed directory and its ancestors."""
        for path in self._managed_ancestors(Path(directory)):
            self._fsync_directory(path)

    def save(self, data: dict) -> None:
        payload = dict(data)
        payload["schema_version"] = SCHEMA_VERSION
        self._atomic_json(self.registry_path, payload)

    @contextlib.contextmanager
    def mutation_lock(self) -> Iterator[None]:
        with self.lock_path.open("a+") as handle:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise LifecycleError("host_busy", "another lifecycle mutation is in progress") from exc
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def owned_path(self, *parts: str) -> Path:
        if not parts or any(not IDENTIFIER.fullmatch(part) or part in {".", ".."} for part in parts):
            raise LifecycleError("invalid_argument", "names and versions must be safe path components")
        candidate = self.root.joinpath(*parts)
        resolved_candidate = candidate.resolve(strict=False)
        try:
            resolved_candidate.relative_to(self.root.resolve())
        except ValueError as exc:
            raise LifecycleError("unsafe_path", "managed path escapes the storage root") from exc
        return candidate

    def require_no_journal(self) -> None:
        if not self.journal_path.exists():
            return
        try:
            journal = json.loads(self.journal_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            journal = {"operation_id": "unknown", "stage": "unreadable"}
        details = dict(journal)
        details["journal"] = str(self.journal_path)
        raise LifecycleError("recovery_required", "an earlier operation requires manual recovery", details)

    def begin(self, operation: str, resources: list[str]) -> dict:
        self.require_no_journal()
        journal = {
            "operation_id": str(uuid.uuid4()),
            "operation": operation,
            "stage": "prepared",
            "resources": resources,
            "recovery": "inspect the listed domain/storage resources, reconcile ownership, then remove this journal",
        }
        self._atomic_json(self.journal_path, journal)
        return journal

    def update_journal(self, journal: dict, stage: str, **details) -> None:
        journal.update(details)
        journal["stage"] = stage
        self._atomic_json(self.journal_path, journal)

    def clear_journal(self) -> None:
        self.journal_path.unlink(missing_ok=True)
        self._fsync_directory(self.journal_path.parent)
