import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("qemu-img"), "qemu-img is not installed")
class QemuImageIntegrationTests(unittest.TestCase):
    def test_temporary_flatten_and_linked_clone_chain(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.qcow2"
            flat = root / "flat.qcow2"
            overlay = root / "overlay.qcow2"
            subprocess.run(["qemu-img", "create", "-f", "qcow2", str(source), "1M"], check=True, capture_output=True)
            subprocess.run(["qemu-img", "convert", "-O", "qcow2", str(source), str(flat)], check=True, capture_output=True)
            subprocess.run(
                ["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", str(flat.resolve()), str(overlay)],
                check=True,
                capture_output=True,
            )
            info = json.loads(
                subprocess.run(
                    ["qemu-img", "info", "--output=json", "--backing-chain", str(overlay)],
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout
            )
            self.assertEqual(str(flat.resolve()), info[0]["full-backing-filename"])
            self.assertEqual(2, len(info))


if __name__ == "__main__":
    unittest.main()
