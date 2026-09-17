import multiprocessing
import os
import stat
import tempfile
import unittest
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from libvirt_mcp.errors import LifecycleError
from libvirt_mcp.store import Store


def hold_lock(root, ready, release):
    with Store(Path(root)).mutation_lock():
        ready.set()
        release.wait(5)


class StoreTests(unittest.TestCase):
    def test_registry_is_schema_versioned_and_atomic(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp))
            data = store.load()
            self.assertEqual(1, data["schema_version"])
            data["vms"]["one"] = {"uuid": "u"}
            store.save(data)
            self.assertEqual("u", Store(Path(tmp)).load()["vms"]["one"]["uuid"])
            self.assertFalse((Path(tmp) / "registry.json.tmp").exists())

    def test_atomic_replace_and_journal_unlink_fsync_parent_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory_syncs = []
            real_fsync = os.fsync

            def recording_fsync(fd):
                if stat.S_ISDIR(os.fstat(fd).st_mode):
                    directory_syncs.append(fd)
                return real_fsync(fd)

            store = Store(Path(tmp))
            with patch("libvirt_mcp.store.os.fsync", side_effect=recording_fsync):
                store.save(store.load())
                self.assertTrue(directory_syncs)
                directory_syncs.clear()
                store.begin("test", [])
                directory_syncs.clear()
                store.clear_journal()
                self.assertTrue(directory_syncs)

    def test_cross_process_mutations_fail_fast(self):
        with tempfile.TemporaryDirectory() as tmp:
            ready = multiprocessing.Event()
            release = multiprocessing.Event()
            process = multiprocessing.Process(target=hold_lock, args=(tmp, ready, release))
            process.start()
            self.assertTrue(ready.wait(5))
            try:
                with self.assertRaises(LifecycleError) as caught:
                    with Store(Path(tmp)).mutation_lock():
                        pass
                self.assertEqual("host_busy", caught.exception.code)
            finally:
                release.set()
                process.join(5)

    def test_symlink_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            root = Path(tmp)
            root.mkdir(exist_ok=True)
            (root / "templates").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(LifecycleError) as caught:
                Store(root).owned_path("templates", "safe", "v1")
            self.assertEqual("unsafe_path", caught.exception.code)

    def test_final_component_symlink_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            root = Path(tmp)
            target = root / "vms" / "safe"
            target.parent.mkdir()
            target.symlink_to(outside, target_is_directory=True)
            with self.assertRaises(LifecycleError) as caught:
                Store(root).owned_path("vms", "safe")
            self.assertEqual("unsafe_path", caught.exception.code)


if __name__ == "__main__":
    unittest.main()
