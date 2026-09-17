from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from libvirt_mcp.errors import LifecycleError
from libvirt_mcp.guest_access import (
    PREPARED_TEMPLATE_CONTRACT,
    GuestAccessProvisioner,
    LibguestfsGuestAdapter,
    build_guest_command,
    parse_guest_account,
    validate_guest_access,
)


PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f project-vm"
FINGERPRINT = "SHA256:ZkAslGjFiUHdGf/WUL8rQvkib4PTvQatUV0OUQSncCA"


class GuestFixture:
    def __init__(self, root: Path, *, home: str = "/srv/projects/developer"):
        self.root = root
        self.home = home
        self.uid = os.getuid()
        self.gid = os.getgid()
        self._write("/etc/passwd", f"root:x:0:0:root:/root:/bin/bash\ndeveloper:x:{self.uid}:{self.gid}:Developer:{home}:/bin/bash\n")
        self._write("/etc/shells", "/bin/bash\n/bin/sh\n")
        shell = self.path("/bin/bash")
        shell.parent.mkdir(parents=True, exist_ok=True)
        shell.write_text("fixture executable\n", encoding="utf-8")
        shell.chmod(0o755)
        self._write(
            "/etc/libvirt-toolkit/guest-access-v1.json",
            json.dumps(PREPARED_TEMPLATE_CONTRACT, sort_keys=True) + "\n",
        )
        self._write("/etc/cloud/cloud-init.disabled", "")
        self.path("/run").mkdir(parents=True)
        self.set_policy()
        authorized = self.path(home + "/.ssh/authorized_keys")
        authorized.parent.mkdir(parents=True)
        authorized.write_text("ssh-ed25519 inherited-one\nssh-ed25519 inherited-two\n", encoding="utf-8")

    def path(self, absolute: str) -> Path:
        return self.root.joinpath(*Path(absolute).parts[1:])

    def _write(self, absolute: str, content: str) -> None:
        path = self.path(absolute)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def set_policy(
        self,
        *,
        pubkey_authentication: str = "yes",
        authorized_keys_file: str = ".ssh/authorized_keys",
        authorized_keys_command: str = "none",
        trusted_user_ca_keys: str = "none",
    ) -> None:
        self._write(
            "/etc/ssh/sshd_config",
            f"PubkeyAuthentication {pubkey_authentication}\n"
            f"AuthorizedKeysFile {authorized_keys_file}\n"
            f"AuthorizedKeysCommand {authorized_keys_command}\n"
            f"TrustedUserCAKeys {trusted_user_ca_keys}\n",
        )

    def account(self):
        return parse_guest_account(
            self.path("/etc/passwd").read_text(encoding="utf-8"),
            self.path("/etc/shells").read_text(encoding="utf-8"),
            "developer",
        )

    def run(self, mode: str = "provision") -> subprocess.CompletedProcess[str]:
        request = validate_guest_access("developer", PUBLIC_KEY)
        command = build_guest_command(self.root, self.account(), request, mode=mode)
        return subprocess.run(
            ["/bin/sh", "-c", command], capture_output=True, text=True, check=False, timeout=10
        )


class ExactProductionTransformationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = [name for name in ("sshd", "ssh-keygen") if shutil.which(name) is None]
        if missing:
            raise RuntimeError(
                "required exact guest-access test prerequisites are missing: "
                + ", ".join(missing)
                + "; install OpenSSH server and client tools"
            )

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "guest"
        self.fixture = GuestFixture(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_exact_production_commands_replace_keys_and_read_back_nondefault_home(self):
        self.assertEqual([], list(self.fixture.path("/etc/ssh").glob("ssh_host_*")))
        self.assertFalse(self.fixture.path("/run/sshd").exists())

        provisioned = self.fixture.run("provision")
        verified = self.fixture.run("verify")

        self.assertEqual(0, provisioned.returncode, provisioned.stderr)
        self.assertEqual(0, verified.returncode, verified.stderr)
        authorized = self.fixture.path(self.fixture.home + "/.ssh/authorized_keys")
        ssh_dir = authorized.parent
        self.assertEqual(PUBLIC_KEY + "\n", authorized.read_text(encoding="utf-8"))
        self.assertEqual(0o700, stat.S_IMODE(ssh_dir.stat().st_mode))
        self.assertEqual(0o600, stat.S_IMODE(authorized.stat().st_mode))
        self.assertEqual((self.fixture.uid, self.fixture.gid), (ssh_dir.stat().st_uid, ssh_dir.stat().st_gid))
        self.assertEqual((self.fixture.uid, self.fixture.gid), (authorized.stat().st_uid, authorized.stat().st_gid))
        self.assertEqual([], list(self.fixture.path("/etc/ssh").glob("ssh_host_*")))
        self.assertFalse(self.fixture.path("/run/sshd").exists())

    def test_transient_runtime_directory_exists_for_sshd_and_is_cleaned(self):
        fake_bin = Path(self.temp.name) / "bin"
        fake_bin.mkdir()
        observed = Path(self.temp.name) / "runtime-observed"
        fake_sshd = fake_bin / "sshd"
        fake_sshd.write_text(
            "#!/bin/sh\n"
            "test -d \"$EXPECTED_SSHD_RUNTIME\" || exit 99\n"
            "touch \"$SSHD_RUNTIME_OBSERVED\"\n"
            "printf '%s\\n' 'PubkeyAuthentication yes' "
            "'AuthorizedKeysFile .ssh/authorized_keys' "
            "'AuthorizedKeysCommand none' 'TrustedUserCAKeys none'\n",
            encoding="utf-8",
        )
        fake_sshd.chmod(0o755)
        request = validate_guest_access("developer", PUBLIC_KEY)
        command = build_guest_command(self.root, self.fixture.account(), request, mode="provision")
        environment = dict(os.environ)
        environment["PATH"] = str(fake_bin) + os.pathsep + environment["PATH"]
        environment["EXPECTED_SSHD_RUNTIME"] = str(self.fixture.path("/run/sshd"))
        environment["SSHD_RUNTIME_OBSERVED"] = str(observed)

        result = subprocess.run(
            ["/bin/sh", "-c", command],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
            env=environment,
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue(observed.is_file())
        self.assertFalse(self.fixture.path("/run/sshd").exists())

    def test_existing_runtime_directory_and_contents_are_preserved(self):
        runtime = self.fixture.path("/run/sshd")
        runtime.mkdir(parents=True)
        sentinel = runtime / "consumer-owned"
        sentinel.write_text("keep\n", encoding="utf-8")

        result = self.fixture.run()

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("keep\n", sentinel.read_text(encoding="utf-8"))

    def test_transient_runtime_directory_is_cleaned_when_policy_setup_fails(self):
        fake_bin = Path(self.temp.name) / "failing-bin"
        fake_bin.mkdir()
        fake_mktemp = fake_bin / "mktemp"
        fake_mktemp.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        fake_mktemp.chmod(0o755)
        request = validate_guest_access("developer", PUBLIC_KEY)
        command = build_guest_command(self.root, self.fixture.account(), request, mode="provision")
        environment = dict(os.environ)
        environment["PATH"] = str(fake_bin) + os.pathsep + environment["PATH"]

        result = subprocess.run(
            ["/bin/sh", "-c", command],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
            env=environment,
        )

        self.assertEqual(41, result.returncode, result.stderr)
        self.assertFalse(self.fixture.path("/run/sshd").exists())

    def test_each_incompatible_effective_policy_is_fatal_before_replacement(self):
        cases = {
            "public-key authentication disabled": {"pubkey_authentication": "no"},
            "additional key store": {"authorized_keys_file": ".ssh/authorized_keys /etc/ssh/keys/%u"},
            "key command": {"authorized_keys_command": "/bin/true"},
            "trusted CA": {"trusted_user_ca_keys": "/etc/ssh/ca.pub"},
        }
        authorized = self.fixture.path(self.fixture.home + "/.ssh/authorized_keys")
        inherited = authorized.read_text(encoding="utf-8")
        for label, policy in cases.items():
            with self.subTest(label=label):
                self.fixture.set_policy(**policy)
                result = self.fixture.run()
                self.assertEqual(43, result.returncode, result.stderr)
                self.assertEqual(inherited, authorized.read_text(encoding="utf-8"))
                self.assertFalse(self.fixture.path("/run/sshd").exists())
                self.fixture.set_policy()

    def test_symlinked_home_ancestor_is_rejected_before_replacement(self):
        authorized = self.fixture.path(self.fixture.home + "/.ssh/authorized_keys")
        inherited = authorized.read_text(encoding="utf-8")
        real_srv = self.root / "real-srv"
        (self.root / "srv").rename(real_srv)
        (self.root / "srv").symlink_to(real_srv, target_is_directory=True)

        result = self.fixture.run()

        self.assertEqual(42, result.returncode, result.stderr)
        self.assertEqual(inherited, real_srv.joinpath("projects/developer/.ssh/authorized_keys").read_text(encoding="utf-8"))

    def test_missing_shell_executable_is_rejected(self):
        self.fixture.path("/bin/bash").unlink()
        result = self.fixture.run()
        self.assertEqual(41, result.returncode, result.stderr)


class GuestAccessValidationTests(unittest.TestCase):
    def test_accepts_nondefault_normalized_home_and_approved_executable_shell_metadata(self):
        account = parse_guest_account(
            "developer:x:1000:1000:Developer:/srv/projects/developer:/bin/bash\n",
            "/bin/bash\n/bin/sh\n",
            "developer",
        )
        self.assertEqual("/srv/projects/developer", account.home)
        self.assertEqual("/bin/bash", account.shell)

    def test_rejects_invalid_ids_home_and_shell_metadata(self):
        cases = [
            "developer:x:-1:1000:Developer:/home/developer:/bin/bash\n",
            "developer:x:4294967295:1000:Developer:/home/developer:/bin/bash\n",
            "developer:x:1000:-1:Developer:/home/developer:/bin/bash\n",
            "developer:x:1000:4294967295:Developer:/home/developer:/bin/bash\n",
            "developer:x:1000:1000:Developer:relative:/bin/bash\n",
            "developer:x:1000:1000:Developer:/srv/../etc:/bin/bash\n",
            "developer:x:1000:1000:Developer:/:/bin/bash\n",
            "developer:x:1000:1000:Developer:/root:/bin/bash\n",
            "developer:x:1000:1000:Developer:/etc:/bin/bash\n",
            "developer:x:1000:1000:Developer:/srv/projects/developer:/usr/sbin/nologin\n",
        ]
        for passwd in cases:
            with self.subTest(passwd=passwd):
                with self.assertRaises(LifecycleError) as caught:
                    parse_guest_account(passwd, "/bin/bash\n/bin/sh\n", "developer")
                self.assertEqual("guest_incompatible", caught.exception.code)

        with self.assertRaises(LifecycleError) as caught:
            parse_guest_account(
                "developer:x:1000:1000:Developer:/srv/projects/developer:/bin/zsh\n",
                "/bin/bash\n/bin/sh\n",
                "developer",
            )
        self.assertEqual("guest_incompatible", caught.exception.code)

    def test_rejects_unsafe_accounts_and_public_keys_before_preflight(self):
        class CountingAdapter:
            preflight_calls = 0

            def preflight(self):
                self.preflight_calls += 1

        adapter = CountingAdapter()
        provisioner = GuestAccessProvisioner(adapter)
        bad_users = ["root", "Developer", "dev user", "../dev", "a" * 33]
        bad_keys = [
            "",
            PUBLIC_KEY + "\n" + PUBLIC_KEY,
            PUBLIC_KEY.replace("ssh-ed25519", "ssh-rsa", 1),
            "from=\"10.0.0.1\" " + PUBLIC_KEY,
            "ssh-ed25519 !!!!",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhsc",
        ]
        for user in bad_users:
            with self.subTest(user=user), self.assertRaises(LifecycleError):
                provisioner.prepare(user, PUBLIC_KEY)
        for key in bad_keys:
            with self.subTest(key=key[:24]), self.assertRaises(LifecycleError):
                provisioner.prepare("developer", key)
        self.assertEqual(0, adapter.preflight_calls)


class LibguestfsAdapterTests(unittest.TestCase):
    def test_preflight_reports_missing_dependency_without_mutation(self):
        class MissingRunner:
            def run(self, argv, timeout_seconds):
                raise LifecycleError("command_unavailable", "missing", {"argv": argv})

        adapter = LibguestfsGuestAdapter(MissingRunner())
        with self.assertRaises(LifecycleError) as caught:
            adapter.preflight()
        self.assertEqual("guest_provisioning_unavailable", caught.exception.code)

    def test_missing_prepared_files_have_compatibility_errors(self):
        class MissingFileRunner:
            def run(self, argv, timeout_seconds):
                return SimpleNamespace(returncode=1, stdout="", stderr="no such file")

        adapter = LibguestfsGuestAdapter(MissingFileRunner())
        request = validate_guest_access("developer", PUBLIC_KEY)
        with self.assertRaises(LifecycleError) as caught:
            adapter.provision(Path("overlay.qcow2"), request)
        self.assertEqual("template_not_prepared", caught.exception.code)

    def test_adapter_uses_bounded_offline_commands_on_only_overlay(self):
        class RecordingRunner:
            def __init__(self):
                self.calls = []

            def run(self, argv, timeout_seconds):
                self.calls.append((list(argv), timeout_seconds))
                values = {
                    "/etc/libvirt-toolkit/guest-access-v1.json": json.dumps(PREPARED_TEMPLATE_CONTRACT) + "\n",
                    "/etc/passwd": "developer:x:1000:1000:Developer:/srv/projects/developer:/bin/bash\n",
                    "/etc/shells": "/bin/bash\n/bin/sh\n",
                    "/etc/cloud/cloud-init.disabled": "",
                    "/etc/ssh/sshd_config": "AuthorizedKeysFile .ssh/authorized_keys\n",
                }
                if argv[0] == "virt-cat" and argv[-1] != "--version":
                    return SimpleNamespace(returncode=0, stdout=values[argv[-1]], stderr="")
                return SimpleNamespace(returncode=0, stdout="", stderr="")

        runner = RecordingRunner()
        adapter = LibguestfsGuestAdapter(runner, timeout_seconds=17)
        request = GuestAccessProvisioner(adapter).prepare("developer", PUBLIC_KEY)
        overlay = Path("/tmp/new-overlay.qcow2")
        adapter.provision(overlay, request)

        customize = [call for call, _timeout in runner.calls if call[0] == "virt-customize" and "-a" in call]
        self.assertEqual(2, len(customize))
        self.assertTrue(all(call[call.index("-a") + 1] == str(overlay) for call in customize))
        self.assertTrue(all("--no-network" in call for call in customize))
        self.assertTrue(all(timeout == 17 for _call, timeout in runner.calls))


if __name__ == "__main__":
    unittest.main()
