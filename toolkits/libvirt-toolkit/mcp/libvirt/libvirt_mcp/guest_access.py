from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import shlex
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from .commands import CommandRunner
from .errors import LifecycleError


ACCOUNT_NAME = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
MAX_LINUX_ID = 2**32 - 2
PREPARED_TEMPLATE_CONTRACT = {
    "authorized_keys": ".ssh/authorized_keys",
    "firstboot_authorized_keys": "disabled",
    "prepared_for": "libvirt-toolkit",
    "version": 1,
}
CONTRACT_PATH = "/etc/libvirt-toolkit/guest-access-v1.json"
EXPECTED_POLICY = {
    "PubkeyAuthentication": "yes",
    "AuthorizedKeysFile": ".ssh/authorized_keys",
    "AuthorizedKeysCommand": "none",
    "TrustedUserCAKeys": "none",
}
SCRIPT_ERRORS = {
    "template_not_prepared": (40, "prepared-template files are missing or unsafe"),
    "guest_incompatible": (41, "selected guest account or OpenSSH installation is incompatible"),
    "unsafe_guest_path": (42, "guest account path contains a symlink or unsafe file type"),
    "incompatible_ssh_policy": (43, "effective SSH authorization policy is incompatible"),
    "guest_postcondition_failed": (44, "guest SSH authorization postconditions did not hold"),
}
SUPPORTED_HOME_ROOTS = ("/home", "/srv", "/opt", "/var/lib")


@dataclass(frozen=True)
class GuestAccessRequest:
    user: str
    public_key: str
    fingerprint: str


@dataclass(frozen=True)
class GuestAccount:
    uid: int
    gid: int
    home: str
    shell: str


def _error(code: str, message: str, details: dict[str, Any] | None = None) -> LifecycleError:
    return LifecycleError(code, message, details or {})


def validate_guest_access(user: str, public_key: str) -> GuestAccessRequest:
    if not isinstance(user, str) or not ACCOUNT_NAME.fullmatch(user) or user == "root":
        raise _error("invalid_guest_access", "guest_user must name a non-root portable local account")
    if not isinstance(public_key, str) or not public_key or "\n" in public_key or "\r" in public_key:
        raise _error("invalid_guest_access", "ssh_public_key must be one OpenSSH Ed25519 public-key line")
    fields = public_key.split()
    if len(fields) not in (2, 3) or fields[0] != "ssh-ed25519":
        raise _error("invalid_guest_access", "ssh_public_key must not contain options and must use Ed25519")
    try:
        blob = base64.b64decode(fields[1], validate=True)
    except (binascii.Error, ValueError) as exc:
        raise _error("invalid_guest_access", "ssh_public_key contains malformed base64") from exc
    algorithm = b"ssh-ed25519"
    expected_prefix = len(algorithm).to_bytes(4, "big") + algorithm + (32).to_bytes(4, "big")
    if len(blob) != len(expected_prefix) + 32 or not blob.startswith(expected_prefix):
        raise _error("invalid_guest_access", "ssh_public_key contains a malformed Ed25519 key blob")
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")
    return GuestAccessRequest(user=user, public_key=" ".join(fields), fingerprint=fingerprint)


def _normalized_absolute(value: str, kind: str) -> str:
    if not isinstance(value, str) or not value.startswith("/") or any(ord(character) < 32 for character in value):
        raise _error("guest_incompatible", f"selected guest account has an unsafe {kind}")
    normalized = str(PurePosixPath(value))
    if normalized != value or value == "/" or any(part in {".", ".."} for part in value.split("/")):
        raise _error("guest_incompatible", f"selected guest account has an unsafe {kind}")
    return value


def parse_guest_account(passwd: str, shells: str, user: str) -> GuestAccount:
    matches = []
    for line in passwd.splitlines():
        fields = line.split(":")
        if len(fields) == 7 and fields[0] == user:
            matches.append(fields)
    if len(matches) != 1:
        raise _error("guest_incompatible", "prepared guest must contain exactly one selected account")
    fields = matches[0]
    try:
        uid, gid = int(fields[2]), int(fields[3])
    except ValueError as exc:
        raise _error("guest_incompatible", "selected guest account has invalid UID/GID") from exc
    if not (0 < uid <= MAX_LINUX_ID and 0 < gid <= MAX_LINUX_ID):
        raise _error("guest_incompatible", "selected guest account UID/GID is outside the supported Linux range")
    home = _normalized_absolute(fields[5], "home directory")
    shell = _normalized_absolute(fields[6], "login shell")
    if not any(home.startswith(root + "/") for root in SUPPORTED_HOME_ROOTS):
        raise _error(
            "guest_incompatible",
            "selected guest account home must be below /home, /srv, /opt, or /var/lib",
        )
    approved_shells = {
        line.strip()
        for line in shells.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    if shell not in approved_shells:
        raise _error("guest_incompatible", "selected guest account shell is not approved by /etc/shells")
    return GuestAccount(uid=uid, gid=gid, home=home, shell=shell)


def _guest_components(path: str) -> list[str]:
    parts = PurePosixPath(path).parts[1:]
    return ["/" + "/".join(parts[:index]) for index in range(1, len(parts) + 1)]


def build_guest_command(
    root: Path, account: GuestAccount, request: GuestAccessRequest, *, mode: str
) -> str:
    """Build the exact bounded command run both in the offline guest and fixture tests."""
    if mode not in {"provision", "verify"}:
        raise ValueError("mode must be provision or verify")
    root_value = "" if Path(root) == Path("/") else str(Path(root).absolute())
    encoded_key = base64.b64encode((request.public_key + "\n").encode("utf-8")).decode("ascii")
    expected_digest = hashlib.sha256((request.public_key + "\n").encode("utf-8")).hexdigest()
    checked_paths = []
    for guest_path in (
        CONTRACT_PATH,
        "/etc/cloud/cloud-init.disabled",
        "/etc/passwd",
        "/etc/shells",
        "/etc/ssh/sshd_config",
        "/run/sshd",
        account.home,
        account.home + "/.ssh",
        account.home + "/.ssh/authorized_keys",
    ):
        for component in _guest_components(guest_path):
            if component not in checked_paths:
                checked_paths.append(component)
    symlink_checks = " ".join(
        f"[ ! -L \"$root{component}\" ] || fail unsafe_guest_path;" for component in checked_paths
    )
    common = (
        "set -u; "
        f"root={shlex.quote(root_value)}; user={shlex.quote(request.user)}; "
        f"home={shlex.quote(account.home)}; shell_path={shlex.quote(account.shell)}; "
        f"uid={account.uid}; gid={account.gid}; expected_digest={expected_digest}; "
        "fail() { code=$1; eval \"number=\\$error_$code\"; "
        "printf 'LIBVIRT_TOOLKIT_ERROR:%s\\n' \"$code\" >&2; exit \"$number\"; }; "
        + " ".join(f"error_{code}={number};" for code, (number, _message) in SCRIPT_ERRORS.items())
        + symlink_checks
        + " [ -f \"$root/etc/libvirt-toolkit/guest-access-v1.json\" ] || fail template_not_prepared; "
        "[ -f \"$root/etc/cloud/cloud-init.disabled\" ] || fail template_not_prepared; "
        "[ -f \"$root/etc/passwd\" ] || fail guest_incompatible; "
        "[ -f \"$root/etc/shells\" ] || fail guest_incompatible; "
        "[ -f \"$root/etc/ssh/sshd_config\" ] || fail guest_incompatible; "
        "[ -d \"$root/run\" ] || fail guest_incompatible; "
        "[ -f \"$root$shell_path\" ] && [ -x \"$root$shell_path\" ] || fail guest_incompatible; "
        "[ -d \"$root$home\" ] || fail unsafe_guest_path; "
        "[ \"$(stat -c '%u:%g' \"$root$home\")\" = \"$uid:$gid\" ] || fail unsafe_guest_path; "
    )
    verify = (
        "[ ! -L \"$root$home/.ssh\" ] && [ -d \"$root$home/.ssh\" ] || fail unsafe_guest_path; "
        "[ ! -L \"$root$home/.ssh/authorized_keys\" ] && "
        "[ -f \"$root$home/.ssh/authorized_keys\" ] || fail unsafe_guest_path; "
        "[ \"$(stat -c '%a:%u:%g' \"$root$home/.ssh\")\" = \"700:$uid:$gid\" ] || fail guest_postcondition_failed; "
        "[ \"$(stat -c '%a:%u:%g' \"$root$home/.ssh/authorized_keys\")\" = \"600:$uid:$gid\" ] || fail guest_postcondition_failed; "
        "[ \"$(sha256sum \"$root$home/.ssh/authorized_keys\" | cut -d' ' -f1)\" = \"$expected_digest\" ] "
        "|| fail guest_postcondition_failed"
    )
    if mode == "verify":
        return common + verify

    policy_checks = " ".join(
        "if ! require_policy " + shlex.quote(key) + " " + shlex.quote(value) + "; then "
        "fail incompatible_ssh_policy; fi;"
        for key, value in EXPECTED_POLICY.items()
    )
    return (
        common
        + "[ ! -e \"$root$home/.ssh\" ] || [ -d \"$root$home/.ssh\" ] || fail unsafe_guest_path; "
        "[ ! -e \"$root$home/.ssh/authorized_keys\" ] || "
        "[ -f \"$root$home/.ssh/authorized_keys\" ] || fail unsafe_guest_path; "
        "command -v ssh-keygen >/dev/null 2>&1 || fail guest_incompatible; "
        "command -v sshd >/dev/null 2>&1 || fail guest_incompatible; "
        "runtime_dir=\"$root/run/sshd\"; runtime_created=0; policy_dir=; tmp=; "
        "cleanup() { [ -z \"$policy_dir\" ] || rm -rf \"$policy_dir\"; "
        "[ -z \"$tmp\" ] || rm -f \"$tmp\"; "
        "if [ \"$runtime_created\" = 1 ]; then "
        "rmdir \"$runtime_dir\" 2>/dev/null && runtime_created=0 || :; fi; }; "
        "trap cleanup EXIT; trap 'cleanup; exit 1' HUP INT TERM; "
        "if [ ! -e \"$runtime_dir\" ]; then "
        "install -d -m 0755 \"$runtime_dir\" || fail guest_incompatible; runtime_created=1; "
        "elif [ ! -d \"$runtime_dir\" ]; then fail unsafe_guest_path; fi; "
        "policy_dir=$(mktemp -d) || fail guest_incompatible; "
        "ssh-keygen -q -t ed25519 -N '' -f \"$policy_dir/host_key\" || fail guest_incompatible; "
        "sshd -T -h \"$policy_dir/host_key\" -f \"$root/etc/ssh/sshd_config\" "
        "-C user=\"$user\",host=localhost,addr=127.0.0.1 >\"$policy_dir/effective\" 2>/dev/null "
        "|| fail incompatible_ssh_policy; "
        "require_policy() { wanted_key=$1; wanted_value=$2; "
        "awk -v wanted_key=\"$wanted_key\" -v wanted_value=\"$wanted_value\" "
        "'tolower($1) == tolower(wanted_key) { count++; $1=\"\"; sub(/^[ \\t]+/, \"\"); value=$0 } "
        "END { exit !(count == 1 && value == wanted_value) }' \"$policy_dir/effective\"; }; "
        + policy_checks
        + "rm -rf \"$policy_dir\" || fail guest_postcondition_failed; policy_dir=; "
        "if [ \"$runtime_created\" = 1 ]; then "
        "rmdir \"$runtime_dir\" || fail guest_postcondition_failed; runtime_created=0; fi; "
        + "install -d -m 0700 -o \"$uid\" -g \"$gid\" \"$root$home/.ssh\" || fail unsafe_guest_path; "
        "tmp=$(mktemp \"$root$home/.ssh/.authorized_keys.XXXXXX\") || fail unsafe_guest_path; "
        f"printf '%s' {shlex.quote(encoded_key)} | base64 -d >\"$tmp\" || fail guest_postcondition_failed; "
        "chmod 0600 \"$tmp\" && chown \"$uid:$gid\" \"$tmp\" || fail guest_postcondition_failed; "
        "mv -f \"$tmp\" \"$root$home/.ssh/authorized_keys\" || fail guest_postcondition_failed; tmp=; "
        + verify
    )


class GuestAccessProvisioner:
    def __init__(self, adapter: Any):
        self.adapter = adapter

    def prepare(self, user: str, public_key: str) -> GuestAccessRequest:
        request = validate_guest_access(user, public_key)
        self.adapter.preflight()
        return request

    def provision(self, image: Path, request: GuestAccessRequest) -> dict[str, str]:
        self.adapter.provision(Path(image), request)
        return {"user": request.user, "fingerprint": request.fingerprint, "status": "provisioned"}


class LibguestfsGuestAdapter:
    """Bounded offline adapter using libguestfs commands only on the new overlay."""

    def __init__(self, runner=None, *, timeout_seconds: float = 120):
        self.runner = runner or CommandRunner()
        self.timeout_seconds = timeout_seconds

    def _run(self, argv: list[str], *, allow_failure: bool = False):
        try:
            result = self.runner.run(argv, timeout_seconds=self.timeout_seconds)
        except LifecycleError as exc:
            raise _error(
                "guest_provision_failed",
                "offline guest customization command could not complete",
                {
                    "executable": argv[0],
                    "cause": exc.code,
                    "side_effect_unknown": bool(exc.details.get("side_effect_unknown")),
                },
            ) from exc
        if result.returncode and not allow_failure:
            raise _error(
                "guest_provision_failed",
                "offline guest customization command failed",
                {"argv": argv[:4], "returncode": result.returncode, "stderr": result.stderr.strip()},
            )
        return result

    def preflight(self) -> None:
        for executable in ("virt-customize", "virt-cat"):
            try:
                result = self._run([executable, "--version"], allow_failure=True)
            except LifecycleError as exc:
                raise _error(
                    "guest_provisioning_unavailable",
                    "required offline guest customization tooling is unavailable",
                    {"executable": executable, "cause": exc.code},
                ) from exc
            if result.returncode:
                raise _error(
                    "guest_provisioning_unavailable",
                    "required offline guest customization tooling is unavailable",
                    {"executable": executable},
                )

    def _cat_required(self, image: Path, guest_path: str, code: str, message: str) -> str:
        result = self._run(["virt-cat", "-a", str(image), guest_path], allow_failure=True)
        if result.returncode:
            raise _error(code, message, {"path": guest_path})
        return result.stdout

    @staticmethod
    def _raise_script_failure(result) -> None:
        for code, (_number, message) in SCRIPT_ERRORS.items():
            if f"LIBVIRT_TOOLKIT_ERROR:{code}" in result.stderr:
                raise _error(code, message)
        raise _error(
            "guest_provision_failed",
            "offline guest transformation failed without a recognized compatibility result",
            {"returncode": result.returncode, "stderr": result.stderr.strip()},
        )

    def provision(self, image: Path, request: GuestAccessRequest) -> None:
        contract_text = self._cat_required(
            image, CONTRACT_PATH, "template_not_prepared", "guest preparation contract is missing"
        )
        try:
            contract = json.loads(contract_text)
        except json.JSONDecodeError as exc:
            raise _error("template_not_prepared", "guest preparation contract is unreadable") from exc
        if contract != PREPARED_TEMPLATE_CONTRACT:
            raise _error("template_not_prepared", "guest preparation contract is unsupported")
        self._cat_required(
            image,
            "/etc/cloud/cloud-init.disabled",
            "template_not_prepared",
            "prepared guest is missing the cloud-init disable marker",
        )
        passwd = self._cat_required(
            image, "/etc/passwd", "guest_incompatible", "prepared guest is missing /etc/passwd"
        )
        shells = self._cat_required(
            image, "/etc/shells", "guest_incompatible", "prepared guest is missing /etc/shells"
        )
        self._cat_required(
            image,
            "/etc/ssh/sshd_config",
            "guest_incompatible",
            "prepared guest is missing the OpenSSH server configuration",
        )
        account = parse_guest_account(passwd, shells, request.user)
        for mode in ("provision", "verify"):
            command = build_guest_command(Path("/"), account, request, mode=mode)
            result = self._run(
                ["virt-customize", "-a", str(image), "--no-network", "--run-command", command],
                allow_failure=True,
            )
            if result.returncode:
                self._raise_script_failure(result)


__all__ = [
    "GuestAccessProvisioner",
    "GuestAccessRequest",
    "LibguestfsGuestAdapter",
    "PREPARED_TEMPLATE_CONTRACT",
    "build_guest_command",
    "parse_guest_account",
    "validate_guest_access",
]
