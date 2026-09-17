import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


HELPER = (
    Path(__file__).resolve().parents[3]
    / "skills"
    / "dotknewt-guest-access"
    / "scripts"
    / "project_ssh.py"
)
VM_UUID = "11111111-2222-4333-8444-555555555555"


class ProjectSshTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.base = Path(self.temporary_directory.name)
        self.project = self.base / "project with spaces"
        self.project.mkdir()

    def run_helper(self, *arguments, env=None, helper=HELPER, expect=0):
        try:
            result = subprocess.run(
                [sys.executable, str(helper), *map(str, arguments)],
                cwd=self.base,
                env=env,
                text=True,
                capture_output=True,
                check=False,
                timeout=10,
            )
        except subprocess.TimeoutExpired:
            self.fail("credential helper exceeded its bounded execution time")
        self.assertEqual(expect, result.returncode, result.stderr)
        stream = result.stdout if expect == 0 else result.stderr
        try:
            return json.loads(stream)
        except json.JSONDecodeError:
            self.fail(f"helper did not emit JSON: {stream!r}")

    def prepare(self, *, project=None, vm_name="dev-vm", env=None, helper=HELPER):
        return self.run_helper(
            "prepare",
            "--project-root",
            project or self.project,
            "--vm-name",
            vm_name,
            "--provider",
            "libvirt",
            "--guest-user",
            "developer",
            env=env,
            helper=helper,
        )

    def identity_arguments(self, prepared):
        return (
            "--credential-dir",
            prepared["credential_dir"],
            "--provider",
            "libvirt",
            "--vm-name",
            "dev-vm",
            "--creation-id",
            prepared["creation_id"],
            "--vm-uuid",
            VM_UUID,
            "--fingerprint",
            prepared["fingerprint"],
            "--guest-user",
            "developer",
        )

    def bind(self, prepared, **overrides):
        values = {
            "credential-dir": prepared["credential_dir"],
            "provider": "libvirt",
            "vm-name": "dev-vm",
            "creation-id": prepared["creation_id"],
            "vm-uuid": VM_UUID,
            "fingerprint": prepared["fingerprint"],
            "guest-user": "developer",
        }
        values.update(overrides)
        arguments = ["bind"]
        for name, value in values.items():
            arguments.extend((f"--{name}", value))
        return self.run_helper(*arguments)

    def host_key(self, name):
        private_key = self.base / name
        subprocess.run(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(private_key)],
            check=True,
            capture_output=True,
            timeout=10,
        )
        public_key = private_key.with_suffix(".pub")
        fingerprint = subprocess.run(
            ["ssh-keygen", "-E", "sha256", "-lf", str(public_key)],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.split()[1]
        return public_key, fingerprint

    def candidate(self, name, *public_keys):
        candidate = self.base / name
        lines = []
        for index, public_key in enumerate(public_keys):
            algorithm, blob, *_ = public_key.read_text(encoding="utf-8").split()
            lines.append(f"scan-{index} {algorithm} {blob}\n")
        candidate.write_text("".join(lines), encoding="utf-8")
        return candidate

    def enroll_arguments(
        self,
        prepared,
        candidate,
        trusted_fingerprint,
        *,
        hostname="guest.example",
        port="2222",
        host_key_alias=None,
    ):
        arguments = [
            "enroll",
            *self.identity_arguments(prepared),
            "--hostname",
            hostname,
            "--port",
            port,
            "--trusted-host-fingerprint",
            trusted_fingerprint,
            "--candidate-file",
            candidate,
        ]
        if host_key_alias is not None:
            arguments.extend(("--host-key-alias", host_key_alias))
        return arguments

    def test_prepare_creates_distinct_keys_secure_records_and_preserves_gitignore(self):
        original = "# consumer rules\n/build/\n"
        (self.project / ".gitignore").write_text(original, encoding="utf-8")

        first = self.prepare()
        second = self.prepare()

        self.assertNotEqual(first["creation_id"], second["creation_id"])
        self.assertNotEqual(first["fingerprint"], second["fingerprint"])
        self.assertNotEqual(first["credential_dir"], second["credential_dir"])
        self.assertEqual(
            {
                "creation_id",
                "credential_dir",
                "fingerprint",
                "guest_user",
                "private_key_path",
                "provider",
                "public_key_path",
                "status",
                "vm_name",
                "vm_uuid",
            },
            set(first),
        )
        self.assertIsNone(first["vm_uuid"])
        credential_dir = Path(first["credential_dir"])
        self.assertEqual(0o700, stat.S_IMODE(credential_dir.stat().st_mode))
        self.assertEqual(0o600, stat.S_IMODE((credential_dir / "id_ed25519").stat().st_mode))
        self.assertEqual(0o600, stat.S_IMODE((credential_dir / "connection.json").stat().st_mode))
        record = json.loads((credential_dir / "connection.json").read_text(encoding="utf-8"))
        self.assertEqual(
            {
                "creation_id": first["creation_id"],
                "fingerprint": first["fingerprint"],
                "guest_user": "developer",
                "provider": "libvirt",
                "status": "pending",
                "vm_name": "dev-vm",
                "vm_uuid": None,
            },
            record,
        )
        self.assertEqual(original + "/.libvirt-toolkit/\n", (self.project / ".gitignore").read_text(encoding="utf-8"))
        self.assertEqual(
            str(credential_dir / "id_ed25519"),
            first["private_key_path"],
        )

    def test_prepare_preserves_non_utf8_gitignore_bytes(self):
        original = b"# consumer byte: \xff\n/build/\n"
        (self.project / ".gitignore").write_bytes(original)

        self.prepare()

        self.assertEqual(original + b"/.libvirt-toolkit/\n", (self.project / ".gitignore").read_bytes())

    def test_prepare_rejects_relative_root_unsafe_name_and_symlink_components(self):
        relative = self.run_helper(
            "prepare",
            "--project-root",
            "relative",
            "--vm-name",
            "dev-vm",
            "--provider",
            "libvirt",
            "--guest-user",
            "developer",
            expect=2,
        )
        self.assertEqual("invalid_argument", relative["error"]["code"])

        unsafe = self.run_helper(
            "prepare",
            "--project-root",
            self.project,
            "--vm-name",
            "../escape",
            "--provider",
            "libvirt",
            "--guest-user",
            "developer",
            expect=2,
        )
        self.assertEqual("invalid_argument", unsafe["error"]["code"])

        real = self.base / "real"
        real.mkdir()
        linked = self.base / "linked"
        linked.symlink_to(real, target_is_directory=True)
        symlinked = self.run_helper(
            "prepare",
            "--project-root",
            linked,
            "--vm-name",
            "dev-vm",
            "--provider",
            "libvirt",
            "--guest-user",
            "developer",
            expect=2,
        )
        self.assertEqual("unsafe_path", symlinked["error"]["code"])

    def test_prepare_rejects_symlink_gitignore_without_touching_target(self):
        target = self.base / "outside-ignore"
        target.write_text("keep\n", encoding="utf-8")
        (self.project / ".gitignore").symlink_to(target)

        error = self.run_helper(
            "prepare",
            "--project-root",
            self.project,
            "--vm-name",
            "dev-vm",
            "--provider",
            "libvirt",
            "--guest-user",
            "developer",
            expect=2,
        )

        self.assertEqual("unsafe_path", error["error"]["code"])
        self.assertEqual("keep\n", target.read_text(encoding="utf-8"))
        self.assertFalse((self.project / ".libvirt-toolkit").exists())

    def test_prepare_refuses_existing_file_in_credential_path(self):
        runtime_path = self.project / ".libvirt-toolkit"
        runtime_path.write_text("consumer-owned\n", encoding="utf-8")

        error = self.run_helper(
            "prepare",
            "--project-root",
            self.project,
            "--vm-name",
            "dev-vm",
            "--provider",
            "libvirt",
            "--guest-user",
            "developer",
            expect=2,
        )

        self.assertEqual("unsafe_path", error["error"]["code"])
        self.assertEqual("consumer-owned\n", runtime_path.read_text(encoding="utf-8"))

    def test_keygen_failure_removes_partial_credential_directory(self):
        fake_bin = self.base / "fake-bin"
        fake_bin.mkdir()
        fake = fake_bin / "ssh-keygen"
        fake.write_text("#!/bin/sh\nexit 23\n", encoding="utf-8")
        fake.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = str(fake_bin)

        error = self.run_helper(
            "prepare",
            "--project-root",
            self.project,
            "--vm-name",
            "dev-vm",
            "--provider",
            "libvirt",
            "--guest-user",
            "developer",
            env=env,
            expect=1,
        )

        self.assertEqual("external_command_failed", error["error"]["code"])
        vm_directory = self.project / ".libvirt-toolkit" / "ssh" / "dev-vm"
        self.assertEqual([], list(vm_directory.iterdir()))

    def test_bind_is_idempotent_for_same_identity_and_refuses_reassignment(self):
        prepared = self.prepare()
        first = self.bind(prepared)
        second = self.bind(prepared)
        self.assertEqual("bound", first["status"])
        self.assertNotEqual(prepared["creation_id"], first["vm_uuid"])
        self.assertEqual(VM_UUID, first["vm_uuid"])
        self.assertEqual(first, second)

        error = self.run_helper(
            "bind",
            "--credential-dir",
            prepared["credential_dir"],
            "--provider",
            "libvirt",
            "--vm-name",
            "dev-vm",
            "--creation-id",
            "00000000-0000-4000-8000-000000000000",
            "--vm-uuid",
            VM_UUID,
            "--fingerprint",
            prepared["fingerprint"],
            "--guest-user",
            "developer",
            expect=2,
        )
        self.assertEqual("identity_mismatch", error["error"]["code"])

        error = self.run_helper(
            "bind",
            *self.identity_arguments(prepared),
            "--vm-uuid",
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            expect=2,
        )
        self.assertEqual("identity_mismatch", error["error"]["code"])

    def test_bind_mismatch_preserves_valid_pending_record(self):
        prepared = self.prepare()
        error = self.run_helper(
            "bind",
            *self.identity_arguments(prepared),
            "--guest-user",
            "other-user",
            expect=2,
        )
        self.assertEqual("identity_mismatch", error["error"]["code"])
        record = json.loads((Path(prepared["credential_dir"]) / "connection.json").read_text(encoding="utf-8"))
        self.assertEqual("pending", record["status"])

    def test_bind_refuses_a_pending_record_with_a_preset_vm_uuid(self):
        prepared = self.prepare()
        record_path = Path(prepared["credential_dir"]) / "connection.json"
        record = json.loads(record_path.read_text(encoding="utf-8"))
        record["vm_uuid"] = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        record_path.write_text(json.dumps(record), encoding="utf-8")

        error = self.run_helper("bind", *self.identity_arguments(prepared), expect=2)

        self.assertEqual("credential_tampered", error["error"]["code"])

    def test_verify_refuses_pending_and_detects_public_key_and_mode_tampering(self):
        pending = self.prepare()
        error = self.run_helper("verify", *self.identity_arguments(pending), expect=2)
        self.assertEqual("invalid_state", error["error"]["code"])

        prepared = self.prepare()
        self.bind(prepared)
        public_key = Path(prepared["public_key_path"])
        public_key.write_text("ssh-ed25519 invalid tampered\n", encoding="utf-8")
        error = self.run_helper("verify", *self.identity_arguments(prepared), expect=2)
        self.assertEqual("credential_tampered", error["error"]["code"])

        prepared = self.prepare()
        self.bind(prepared)
        Path(prepared["private_key_path"]).chmod(0o644)
        error = self.run_helper("verify", *self.identity_arguments(prepared), expect=2)
        self.assertEqual("unsafe_permissions", error["error"]["code"])

    def test_verify_rejects_encrypted_and_corrupt_private_keys_without_prompting(self):
        encrypted = self.prepare()
        self.bind(encrypted)
        subprocess.run(
            [
                "ssh-keygen",
                "-q",
                "-p",
                "-P",
                "",
                "-N",
                "secret-passphrase",
                "-f",
                encrypted["private_key_path"],
            ],
            stdin=subprocess.DEVNULL,
            check=True,
            capture_output=True,
            timeout=10,
        )
        error = self.run_helper("verify", *self.identity_arguments(encrypted), expect=2)
        self.assertEqual("credential_tampered", error["error"]["code"])

        corrupt = self.prepare()
        self.bind(corrupt)
        Path(corrupt["private_key_path"]).write_bytes(b"not an SSH private key\n")
        error = self.run_helper("verify", *self.identity_arguments(corrupt), expect=2)
        self.assertEqual("credential_tampered", error["error"]["code"])

    def test_verify_preserves_unavailable_ssh_keygen_as_an_external_error(self):
        prepared = self.prepare()
        self.bind(prepared)
        empty_path = self.base / "empty-path"
        empty_path.mkdir()
        env = os.environ.copy()
        env["PATH"] = str(empty_path)

        error = self.run_helper("verify", *self.identity_arguments(prepared), env=env, expect=1)

        self.assertEqual("external_command_failed", error["error"]["code"])

    def test_enroll_normalizes_direct_ipv6_and_alias_tokens_idempotently(self):
        prepared = self.prepare()
        self.bind(prepared)
        public_key, fingerprint = self.host_key("host-key")
        candidate = self.candidate("candidate", public_key, public_key)

        direct = self.run_helper(*self.enroll_arguments(prepared, candidate, fingerprint))
        repeated = self.run_helper(*self.enroll_arguments(prepared, candidate, fingerprint))
        ipv6 = self.run_helper(
            *self.enroll_arguments(prepared, candidate, fingerprint, hostname="2001:db8::7", port="2200")
        )
        aliased = self.run_helper(
            *self.enroll_arguments(
                prepared,
                candidate,
                fingerprint,
                hostname="127.0.0.1",
                port="32241",
                host_key_alias="dev-vm@hv-east",
            )
        )

        self.assertEqual(direct, repeated)
        self.assertEqual("[guest.example]:2222", direct["host_key_token"])
        self.assertEqual("[2001:db8::7]:2200", ipv6["host_key_token"])
        self.assertEqual("dev-vm@hv-east", aliased["host_key_token"])
        self.assertEqual(fingerprint, direct["host_key_fingerprint"])
        known_hosts = Path(direct["known_hosts_path"])
        self.assertEqual(Path(prepared["credential_dir"]) / "known_hosts", known_hosts)
        self.assertEqual(0o600, stat.S_IMODE(known_hosts.stat().st_mode))
        lines = known_hosts.read_text(encoding="utf-8").splitlines()
        self.assertEqual(3, len(lines))
        self.assertEqual(1, sum(line.startswith("[guest.example]:2222 ") for line in lines))

    def test_expanded_ipv6_enrollment_hostname_drives_configure_and_ssh_G(self):
        prepared = self.prepare()
        self.bind(prepared)
        public_key, fingerprint = self.host_key("ipv6-host-key")
        candidate = self.candidate("ipv6-candidate", public_key)
        expanded = "2001:0db8:0000:0000:0000:0000:0000:0007"

        enrolled = self.run_helper(
            *self.enroll_arguments(
                prepared,
                candidate,
                fingerprint,
                hostname=expanded,
                port="2200",
            )
        )
        configured = self.run_helper(
            "configure",
            *self.identity_arguments(prepared),
            "--hostname",
            enrolled["hostname"],
            "--port",
            str(enrolled["port"]),
            "--known-hosts",
            enrolled["known_hosts_path"],
        )
        inspected = subprocess.run(
            ["ssh", "-G", "-T", "-F", configured["config_path"], configured["alias"]],
            text=True,
            capture_output=True,
            check=True,
        )
        effective = dict(line.partition(" ")[::2] for line in inspected.stdout.splitlines())

        self.assertEqual("2001:db8::7", enrolled["hostname"])
        self.assertEqual("[2001:db8::7]:2200", enrolled["host_key_token"])
        self.assertEqual(enrolled["hostname"], configured["hostname"])
        self.assertEqual("2001:db8::7", effective["hostname"])
        self.assertEqual("2200", effective["port"])
        self.assertEqual(enrolled["known_hosts_path"], effective["userknownhostsfile"])

    def test_enroll_rejects_unsafe_host_tokens_before_trust_store_mutation(self):
        prepared = self.prepare()
        self.bind(prepared)
        public_key, fingerprint = self.host_key("host-key")
        candidate = self.candidate("candidate", public_key)
        known_hosts = Path(prepared["credential_dir"]) / "known_hosts"

        cases = [
            {"hostname": "bad host"},
            {"hostname": "bad\nhost"},
            {"hostname": "bad,host"},
            {"hostname": "bad*host"},
            {"hostname": "bad?host"},
            {"hostname": "!bad"},
            {"hostname": "bad|host"},
            {"hostname": "[2001:db8::7]"},
            {"host_key_alias": "bad alias"},
            {"host_key_alias": "bad,alias"},
            {"host_key_alias": "bad*alias"},
            {"host_key_alias": "bad?alias"},
            {"host_key_alias": "!bad"},
            {"host_key_alias": "bad|alias"},
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                error = self.run_helper(
                    *self.enroll_arguments(prepared, candidate, fingerprint, **overrides), expect=2
                )
                self.assertEqual("invalid_argument", error["error"]["code"])
                expected_field = "host-key-alias" if "host_key_alias" in overrides else "hostname"
                self.assertEqual(expected_field, error["error"]["details"]["field"])
                self.assertFalse(known_hosts.exists())

    def test_enroll_requires_one_trusted_ed25519_key_and_preserves_conflicts(self):
        prepared = self.prepare()
        self.bind(prepared)
        first_key, first_fingerprint = self.host_key("first-host-key")
        second_key, second_fingerprint = self.host_key("second-host-key")
        multiple = self.candidate("multiple-candidates", first_key, second_key)

        error = self.run_helper(
            *self.enroll_arguments(prepared, multiple, first_fingerprint), expect=2
        )
        self.assertEqual("invalid_host_identity", error["error"]["code"])

        first_candidate = self.candidate("first-candidate", first_key)
        error = self.run_helper(
            *self.enroll_arguments(prepared, first_candidate, second_fingerprint), expect=2
        )
        self.assertEqual("host_identity_mismatch", error["error"]["code"])

        enrolled = self.run_helper(
            *self.enroll_arguments(prepared, first_candidate, first_fingerprint)
        )
        known_hosts = Path(enrolled["known_hosts_path"])
        original = known_hosts.read_bytes()
        second_candidate = self.candidate("second-candidate", second_key)
        error = self.run_helper(
            *self.enroll_arguments(prepared, second_candidate, second_fingerprint), expect=2
        )
        self.assertEqual("host_identity_conflict", error["error"]["code"])
        self.assertEqual(original, known_hosts.read_bytes())

    def test_enroll_refuses_symlink_candidate_and_trust_store(self):
        prepared = self.prepare()
        self.bind(prepared)
        public_key, fingerprint = self.host_key("host-key")
        candidate = self.candidate("candidate", public_key)
        linked_candidate = self.base / "linked-candidate"
        linked_candidate.symlink_to(candidate)

        error = self.run_helper(
            *self.enroll_arguments(prepared, linked_candidate, fingerprint), expect=2
        )
        self.assertEqual("unsafe_path", error["error"]["code"])

        known_hosts = Path(prepared["credential_dir"]) / "known_hosts"
        outside = self.base / "outside-known-hosts"
        outside.write_text("preserve\n", encoding="utf-8")
        known_hosts.symlink_to(outside)
        error = self.run_helper(
            *self.enroll_arguments(prepared, candidate, fingerprint), expect=2
        )
        self.assertEqual("unsafe_path", error["error"]["code"])
        self.assertEqual("preserve\n", outside.read_text(encoding="utf-8"))

    def test_enroll_serializes_distinct_token_updates_without_lost_lines(self):
        prepared = self.prepare()
        self.bind(prepared)
        public_key, fingerprint = self.host_key("host-key")
        candidate = self.candidate("candidate", public_key)
        commands = []
        for hostname in ("guest-a.example", "guest-b.example"):
            commands.append(
                subprocess.Popen(
                    [
                        sys.executable,
                        str(HELPER),
                        *self.enroll_arguments(
                            prepared, candidate, fingerprint, hostname=hostname, port="22"
                        ),
                    ],
                    cwd=self.base,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
            )
        results = [process.communicate(timeout=10) + (process.returncode,) for process in commands]
        for stdout, stderr, returncode in results:
            self.assertEqual(0, returncode, stderr)
            self.assertEqual("bound", json.loads(stdout)["status"])

        known_hosts = Path(prepared["credential_dir"]) / "known_hosts"
        lines = known_hosts.read_text(encoding="utf-8").splitlines()
        self.assertEqual(2, len(lines))
        self.assertTrue(any(line.startswith("guest-a.example ") for line in lines))
        self.assertTrue(any(line.startswith("guest-b.example ") for line in lines))

    def test_verify_and_configure_require_both_creation_and_vm_identifiers(self):
        prepared = self.prepare()
        self.bind(prepared)
        verify_arguments = list(self.identity_arguments(prepared))
        verify_arguments[verify_arguments.index("--vm-uuid") + 1] = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

        error = self.run_helper("verify", *verify_arguments, expect=2)

        self.assertEqual("identity_mismatch", error["error"]["code"])
        configure_arguments = list(self.identity_arguments(prepared))
        configure_arguments[configure_arguments.index("--creation-id") + 1] = "00000000-0000-4000-8000-000000000000"
        error = self.run_helper(
            "configure",
            *configure_arguments,
            "--hostname",
            "guest.example",
            "--port",
            "22",
            "--known-hosts",
            self.project / ".libvirt-toolkit" / "known_hosts",
            expect=2,
        )
        self.assertEqual("identity_mismatch", error["error"]["code"])

    def test_configure_requires_bound_identity_and_matching_known_host(self):
        prepared = self.prepare()
        known_hosts = self.project / ".libvirt-toolkit" / "known_hosts"
        known_hosts.write_text("unrelated ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEfake\n", encoding="utf-8")

        error = self.run_helper(
            "configure",
            *self.identity_arguments(prepared),
            "--hostname",
            "guest.example",
            "--port",
            "2222",
            "--known-hosts",
            known_hosts,
            "--host-key-alias",
            "guest-stable-id",
            expect=2,
        )
        self.assertEqual("invalid_state", error["error"]["code"])

        self.bind(prepared)
        error = self.run_helper(
            "configure",
            *self.identity_arguments(prepared),
            "--hostname",
            "guest.example",
            "--port",
            "2222",
            "--known-hosts",
            known_hosts,
            "--host-key-alias",
            "guest-stable-id",
            expect=2,
        )
        self.assertEqual("host_identity_missing", error["error"]["code"])

    def test_configure_quotes_paths_and_ssh_G_reports_strict_effective_settings(self):
        prepared = self.prepare()
        self.bind(prepared)
        host_key = self.base / "host key"
        subprocess.run(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(host_key)],
            check=True,
            capture_output=True,
        )
        public = (host_key.with_suffix(".pub")).read_text(encoding="utf-8").split()
        known_hosts = self.project / ".libvirt-toolkit" / "known hosts"
        known_hosts.write_text(f"guest-stable-id {public[0]} {public[1]}\n", encoding="utf-8")

        configured = self.run_helper(
            "configure",
            *self.identity_arguments(prepared),
            "--hostname",
            "guest.example",
            "--port",
            "2222",
            "--known-hosts",
            known_hosts,
            "--host-key-alias",
            "guest-stable-id",
        )

        inspected = subprocess.run(
            ["ssh", "-G", "-F", configured["config_path"], configured["alias"]],
            text=True,
            capture_output=True,
            check=True,
        )
        effective = {}
        for line in inspected.stdout.splitlines():
            name, _, value = line.partition(" ")
            effective[name] = value
        self.assertEqual("guest.example", effective["hostname"])
        self.assertEqual("2222", effective["port"])
        self.assertEqual("developer", effective["user"])
        self.assertEqual(prepared["private_key_path"], effective["identityfile"])
        self.assertEqual("none", effective["identityagent"])
        self.assertEqual("yes", effective["identitiesonly"])
        self.assertEqual("true", effective["stricthostkeychecking"])
        self.assertEqual(str(known_hosts), effective["userknownhostsfile"])
        self.assertEqual("/dev/null", effective["globalknownhostsfile"])
        self.assertEqual("false", effective["verifyhostkeydns"])
        self.assertEqual("false", effective["updatehostkeys"])
        self.assertNotIn("knownhostscommand", effective)
        self.assertEqual("false", effective["controlmaster"])
        self.assertEqual("yes", effective["batchmode"])
        self.assertEqual("guest-stable-id", effective["hostkeyalias"])

    def test_configure_rejects_control_and_percent_expansion_and_nonproject_trust_store(self):
        prepared = self.prepare()
        self.bind(prepared)
        outside = self.base / "known_hosts"
        outside.write_text("guest ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEfake\n", encoding="utf-8")
        for option, value in (("--hostname", "bad\nhost"), ("--host-key-alias", "%h")):
            arguments = [
                "configure",
                *self.identity_arguments(prepared),
                "--hostname",
                "guest.example",
                "--port",
                "22",
                "--known-hosts",
                outside,
                "--host-key-alias",
                "guest",
            ]
            arguments[arguments.index(option) + 1] = value
            error = self.run_helper(*arguments, expect=2)
            self.assertEqual("invalid_argument", error["error"]["code"])

        error = self.run_helper(
            "configure",
            *self.identity_arguments(prepared),
            "--hostname",
            "guest.example",
            "--port",
            "22",
            "--known-hosts",
            outside,
            "--host-key-alias",
            "guest",
            expect=2,
        )
        self.assertEqual("unsafe_path", error["error"]["code"])

    def test_copied_helper_runs_after_source_checkout_copy_is_removed(self):
        checkout = self.base / "checkout"
        installed = self.base / "installed" / "project_ssh.py"
        checkout.mkdir()
        installed.parent.mkdir()
        staged = checkout / "project_ssh.py"
        shutil.copy2(HELPER, staged)
        shutil.copy2(staged, installed)
        shutil.rmtree(checkout)

        result = self.prepare(helper=installed)

        self.assertEqual("pending", result["status"])


if __name__ == "__main__":
    unittest.main()
