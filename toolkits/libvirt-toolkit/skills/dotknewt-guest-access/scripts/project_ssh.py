#!/usr/bin/env python3
"""Manage project-local SSH credentials for one approved VM creation."""

from __future__ import annotations

import argparse
import base64
import binascii
import fcntl
import hashlib
import ipaddress
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any, NoReturn, Sequence


ALIAS = "project-vm"
COMMAND_TIMEOUT_SECONDS = 10
IGNORE_ENTRY = "/.libvirt-toolkit/"
NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
RECORD_FIELDS = {"provider", "vm_name", "guest_user", "creation_id", "vm_uuid", "fingerprint", "status"}
HOST_TOKEN_METACHARACTERS = frozenset(",*?!|[]#\\")
MAX_CANDIDATE_BYTES = 1024 * 1024


class CredentialError(Exception):
    """A safe, machine-readable credential operation failure."""

    def __init__(self, code: str, message: str, *, exit_code: int = 2, **details: Any):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code
        self.details = details

    def payload(self) -> dict[str, Any]:
        error: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details:
            error["details"] = self.details
        return {"error": error}


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise CredentialError("invalid_argument", message)


def _validate_name(label: str, value: str) -> str:
    if not NAME_PATTERN.fullmatch(value) or value in {".", ".."}:
        raise CredentialError(
            "invalid_argument",
            f"{label} must use only letters, digits, dot, underscore, or hyphen",
            field=label,
        )
    return value


def _validate_config_value(label: str, value: str) -> str:
    if not value or "%" in value or any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise CredentialError(
            "invalid_argument",
            f"{label} is empty or contains a control character or SSH percent token",
            field=label,
        )
    return value


def _validate_host_token_part(label: str, value: str, *, normalize_ipv6: bool = False) -> str:
    value = _validate_config_value(label, value)
    if any(character.isspace() or character in HOST_TOKEN_METACHARACTERS for character in value):
        raise CredentialError(
            "invalid_argument",
            f"{label} contains whitespace or a known-hosts pattern metacharacter",
            field=label,
        )
    if normalize_ipv6 and ":" in value:
        try:
            parsed = ipaddress.ip_address(value)
        except ValueError as error:
            raise CredentialError("invalid_argument", f"{label} contains an invalid IPv6 literal", field=label) from error
        if parsed.version != 6:
            raise CredentialError("invalid_argument", f"{label} contains an invalid IPv6 literal", field=label)
        return parsed.compressed
    return value


def _host_key_token(hostname: str, port: int, host_key_alias: str | None) -> tuple[str, str, str | None]:
    hostname = _validate_host_token_part("hostname", hostname, normalize_ipv6=True)
    if port < 1 or port > 65535:
        raise CredentialError("invalid_argument", "port must be between 1 and 65535", field="port")
    if host_key_alias is not None:
        host_key_alias = _validate_host_token_part("host-key-alias", host_key_alias)
        return host_key_alias, hostname, host_key_alias
    token = hostname if port == 22 else f"[{hostname}]:{port}"
    return token, hostname, None


def _absolute_path(label: str, raw_path: str | os.PathLike[str]) -> Path:
    path = Path(raw_path)
    if not path.is_absolute() or ".." in path.parts:
        raise CredentialError("invalid_argument", f"{label} must be an absolute normalized path", field=label)
    return path


def _assert_no_symlink_components(path: Path, *, require_leaf: bool = True) -> None:
    current = Path(path.anchor)
    parts = path.parts[1:] if path.anchor else path.parts
    for index, part in enumerate(parts):
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            if require_leaf or index != len(parts) - 1:
                raise CredentialError("unsafe_path", "required path does not exist", path=str(current))
            return
        if stat.S_ISLNK(metadata.st_mode):
            raise CredentialError("unsafe_path", "symlink path components are not allowed", path=str(current))
        if index != len(parts) - 1 and not stat.S_ISDIR(metadata.st_mode):
            raise CredentialError("unsafe_path", "non-directory path component", path=str(current))


def _require_directory(label: str, raw_path: str | os.PathLike[str]) -> Path:
    path = _absolute_path(label, raw_path)
    _assert_no_symlink_components(path)
    if not path.is_dir():
        raise CredentialError("unsafe_path", f"{label} must be a directory", path=str(path))
    return path


def _safe_regular_file(path: Path, *, mode: int | None = None) -> os.stat_result:
    _assert_no_symlink_components(path)
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise CredentialError("unsafe_path", "expected a regular file", path=str(path))
    if mode is not None and stat.S_IMODE(metadata.st_mode) != mode:
        raise CredentialError(
            "unsafe_permissions",
            "credential file permissions are unsafe",
            path=str(path),
            expected=oct(mode),
            actual=oct(stat.S_IMODE(metadata.st_mode)),
        )
    return metadata


def _run(command: Sequence[str], *, missing_ok: bool = False) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["LC_ALL"] = "C"
    try:
        result = subprocess.run(
            list(command),
            env=environment,
            stdin=subprocess.DEVNULL,
            text=True,
            capture_output=True,
            check=False,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise CredentialError(
            "external_command_timeout",
            "required SSH command exceeded its time limit",
            exit_code=1,
            command=command[0],
            timeout_seconds=COMMAND_TIMEOUT_SECONDS,
        ) from error
    except OSError as error:
        raise CredentialError(
            "external_command_failed",
            "required SSH command could not be started",
            exit_code=1,
            command=command[0],
            errno=error.errno,
        ) from error
    if result.returncode and not (missing_ok and result.returncode == 1):
        raise CredentialError(
            "external_command_failed",
            "required SSH command failed",
            exit_code=1,
            command=command[0],
            returncode=result.returncode,
            stderr=result.stderr.strip()[:1000],
        )
    return result


def _fingerprint(public_key: Path) -> str:
    result = _run(["ssh-keygen", "-E", "sha256", "-lf", str(public_key)])
    fields = result.stdout.split()
    if len(fields) < 2 or not fields[1].startswith("SHA256:"):
        raise CredentialError("credential_tampered", "could not parse the public-key fingerprint")
    return fields[1]


def _append_runtime_ignore(project_root: Path) -> None:
    ignore = project_root / ".gitignore"
    if ignore.exists() or ignore.is_symlink():
        _safe_regular_file(ignore)
        content = ignore.read_bytes()
    else:
        content = b""
    encoded_entry = IGNORE_ENTRY.encode("ascii")
    if encoded_entry in content.splitlines():
        return
    addition = (b"" if not content or content.endswith(b"\n") else b"\n") + encoded_entry + b"\n"
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(ignore, flags, 0o644)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(addition)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as error:
        raise CredentialError("unsafe_path", "could not safely update .gitignore", path=str(ignore)) from error


def _mkdir_private(path: Path) -> None:
    try:
        path.mkdir(mode=0o700)
        path.chmod(0o700)
    except FileExistsError:
        _assert_no_symlink_components(path)
        if not path.is_dir():
            raise CredentialError("unsafe_path", "credential path component is not a directory", path=str(path))


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        _safe_regular_file(path)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def _result(record: dict[str, Any], credential_dir: Path) -> dict[str, Any]:
    return {
        **record,
        "credential_dir": str(credential_dir),
        "private_key_path": str(credential_dir / "id_ed25519"),
        "public_key_path": str(credential_dir / "id_ed25519.pub"),
    }


def prepare(project_root: str, vm_name: str, provider: str, guest_user: str) -> dict[str, Any]:
    """Create one fresh pending Ed25519 credential set under an absolute project root."""
    root = _require_directory("project-root", project_root)
    vm_name = _validate_name("vm-name", vm_name)
    provider = _validate_name("provider", provider)
    guest_user = _validate_name("guest-user", guest_user)
    _append_runtime_ignore(root)

    credential_base = root / ".libvirt-toolkit" / "ssh" / vm_name
    current = root
    for component in (".libvirt-toolkit", "ssh", vm_name):
        current /= component
        _mkdir_private(current)

    creation_id = str(uuid.uuid4())
    credential_dir = credential_base / creation_id
    try:
        credential_dir.mkdir(mode=0o700)
        credential_dir.chmod(0o700)
    except FileExistsError as error:
        raise CredentialError("credential_exists", "credential directory already exists", path=str(credential_dir)) from error

    private_key = credential_dir / "id_ed25519"
    public_key = credential_dir / "id_ed25519.pub"
    try:
        _run(
            [
                "ssh-keygen",
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                f"{provider}:{vm_name}:{creation_id}",
                "-f",
                str(private_key),
            ]
        )
        _safe_regular_file(private_key)
        _safe_regular_file(public_key)
        private_key.chmod(0o600)
        fingerprint = _fingerprint(public_key)
        record = {
            "provider": provider,
            "vm_name": vm_name,
            "guest_user": guest_user,
            "creation_id": creation_id,
            "vm_uuid": None,
            "fingerprint": fingerprint,
            "status": "pending",
        }
        _atomic_json(credential_dir / "connection.json", record)
        return _result(record, credential_dir)
    except BaseException:
        shutil.rmtree(credential_dir, ignore_errors=True)
        raise


def _load_record(credential_dir: str | os.PathLike[str]) -> tuple[Path, dict[str, Any]]:
    directory = _require_directory("credential-dir", credential_dir)
    if stat.S_IMODE(directory.stat().st_mode) != 0o700:
        raise CredentialError("unsafe_permissions", "credential directory must have mode 0700", path=str(directory))
    record_path = directory / "connection.json"
    _safe_regular_file(record_path, mode=0o600)
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise CredentialError("credential_tampered", "connection record is not valid JSON") from error
    if not isinstance(record, dict) or set(record) != RECORD_FIELDS or record.get("status") not in {"pending", "bound"}:
        raise CredentialError("credential_tampered", "connection record has an invalid schema")
    if record["status"] == "pending" and record["vm_uuid"] is not None:
        raise CredentialError("credential_tampered", "pending connection record already has a VM UUID")
    if record["status"] == "bound":
        try:
            bound_vm_uuid = uuid.UUID(record["vm_uuid"])
        except (AttributeError, TypeError, ValueError) as error:
            raise CredentialError("credential_tampered", "bound connection record has an invalid VM UUID") from error
        if str(bound_vm_uuid) != record["vm_uuid"]:
            raise CredentialError("credential_tampered", "bound connection record has a noncanonical VM UUID")
    return directory, record


def _expected_identity(
    provider: str,
    vm_name: str,
    creation_id: str,
    vm_uuid: str,
    fingerprint: str,
    guest_user: str,
) -> dict[str, str]:
    provider = _validate_name("provider", provider)
    vm_name = _validate_name("vm-name", vm_name)
    guest_user = _validate_name("guest-user", guest_user)
    try:
        parsed_id = uuid.UUID(creation_id)
    except ValueError as error:
        raise CredentialError("invalid_argument", "creation-id must be a UUID", field="creation-id") from error
    if str(parsed_id) != creation_id or parsed_id.version != 4:
        raise CredentialError("invalid_argument", "creation-id must be a canonical UUID4", field="creation-id")
    try:
        parsed_vm_uuid = uuid.UUID(vm_uuid)
    except ValueError as error:
        raise CredentialError("invalid_argument", "vm-uuid must be a UUID", field="vm-uuid") from error
    if str(parsed_vm_uuid) != vm_uuid:
        raise CredentialError("invalid_argument", "vm-uuid must be canonical", field="vm-uuid")
    if not fingerprint.startswith("SHA256:") or any(character.isspace() for character in fingerprint):
        raise CredentialError("invalid_argument", "fingerprint must be an SSH SHA256 fingerprint", field="fingerprint")
    return {
        "provider": provider,
        "vm_name": vm_name,
        "creation_id": creation_id,
        "vm_uuid": vm_uuid,
        "fingerprint": fingerprint,
        "guest_user": guest_user,
    }


def _check_identity(record: dict[str, Any], expected: dict[str, str]) -> None:
    mismatched = [key for key, value in expected.items() if record.get(key) != value]
    if mismatched:
        raise CredentialError("identity_mismatch", "credential identity does not match", fields=mismatched)


def _verify_files(directory: Path, record: dict[str, Any]) -> None:
    private_key = directory / "id_ed25519"
    public_key = directory / "id_ed25519.pub"
    _safe_regular_file(private_key, mode=0o600)
    _safe_regular_file(public_key)
    try:
        public_parts = public_key.read_text(encoding="utf-8").split()
    except UnicodeError as error:
        raise CredentialError("credential_tampered", "public key is not valid text") from error
    if len(public_parts) < 2:
        raise CredentialError("credential_tampered", "public key is malformed")
    try:
        derived = _run(["ssh-keygen", "-y", "-P", "", "-f", str(private_key)]).stdout.split()
    except CredentialError as error:
        if error.code != "external_command_failed" or "returncode" not in error.details:
            raise
        raise CredentialError("credential_tampered", "private key is encrypted, corrupt, or unreadable") from error
    if len(derived) < 2 or derived[:2] != public_parts[:2]:
        raise CredentialError("credential_tampered", "private and public keys do not match")
    if _fingerprint(public_key) != record["fingerprint"]:
        raise CredentialError("credential_tampered", "public-key fingerprint changed")


def bind(
    credential_dir: str,
    provider: str,
    vm_name: str,
    creation_id: str,
    vm_uuid: str,
    fingerprint: str,
    guest_user: str,
) -> dict[str, Any]:
    """Bind a pending record to matching provider-returned identity, idempotently."""
    directory, record = _load_record(credential_dir)
    expected = _expected_identity(provider, vm_name, creation_id, vm_uuid, fingerprint, guest_user)
    _check_identity(record, {key: value for key, value in expected.items() if key != "vm_uuid"})
    _verify_files(directory, record)
    if record["status"] == "pending":
        record["vm_uuid"] = vm_uuid
        record["status"] = "bound"
        _atomic_json(directory / "connection.json", record)
    elif record["vm_uuid"] != vm_uuid:
        raise CredentialError("identity_mismatch", "credential identity does not match", fields=["vm_uuid"])
    return _result(record, directory)


def verify(
    credential_dir: str,
    provider: str,
    vm_name: str,
    creation_id: str,
    vm_uuid: str,
    fingerprint: str,
    guest_user: str,
) -> dict[str, Any]:
    """Verify an exact bound identity and its credential files without network access."""
    directory, record = _load_record(credential_dir)
    expected = _expected_identity(provider, vm_name, creation_id, vm_uuid, fingerprint, guest_user)
    if record["status"] != "bound":
        raise CredentialError("invalid_state", "credential is not bound")
    _check_identity(record, expected)
    _verify_files(directory, record)
    return _result(record, directory)


def _read_regular_file_no_follow(label: str, raw_path: str | os.PathLike[str], *, maximum: int) -> bytes:
    path = _absolute_path(label, raw_path)
    _assert_no_symlink_components(path)
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise CredentialError("unsafe_path", f"could not safely open {label}", path=str(path)) from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise CredentialError("unsafe_path", f"{label} must be a regular file", path=str(path))
        if metadata.st_size > maximum:
            raise CredentialError("invalid_host_identity", f"{label} is too large", path=str(path))
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            content = stream.read(maximum + 1)
        if len(content) > maximum:
            raise CredentialError("invalid_host_identity", f"{label} is too large", path=str(path))
        return content
    finally:
        os.close(descriptor)


def _decode_ed25519_key(algorithm: str, encoded: str, *, error_code: str) -> tuple[str, str]:
    if algorithm != "ssh-ed25519":
        raise CredentialError(error_code, "host identity must use Ed25519")
    try:
        blob = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise CredentialError(error_code, "host identity contains malformed base64") from error
    algorithm_bytes = b"ssh-ed25519"
    prefix = len(algorithm_bytes).to_bytes(4, "big") + algorithm_bytes + (32).to_bytes(4, "big")
    if len(blob) != len(prefix) + 32 or not blob.startswith(prefix):
        raise CredentialError(error_code, "host identity contains a malformed Ed25519 key blob")
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")
    return f"{algorithm} {encoded}", fingerprint


def _trusted_fingerprint(value: str) -> str:
    value = _validate_config_value("trusted-host-fingerprint", value)
    if any(character.isspace() for character in value) or not value.startswith("SHA256:"):
        raise CredentialError(
            "invalid_argument", "trusted-host-fingerprint must be one SSH SHA256 fingerprint", field="trusted-host-fingerprint"
        )
    encoded = value.removeprefix("SHA256:")
    try:
        digest = base64.b64decode(encoded + "=" * (-len(encoded) % 4), validate=True)
    except (binascii.Error, ValueError) as error:
        raise CredentialError(
            "invalid_argument", "trusted-host-fingerprint must be one SSH SHA256 fingerprint", field="trusted-host-fingerprint"
        ) from error
    if len(digest) != hashlib.sha256().digest_size or "=" in encoded:
        raise CredentialError(
            "invalid_argument", "trusted-host-fingerprint must be one SSH SHA256 fingerprint", field="trusted-host-fingerprint"
        )
    return value


def _candidate_identity(candidate_file: str) -> tuple[str, str]:
    content = _read_regular_file_no_follow("candidate-file", candidate_file, maximum=MAX_CANDIDATE_BYTES)
    try:
        lines = content.decode("utf-8").splitlines()
    except UnicodeError as error:
        raise CredentialError("invalid_host_identity", "candidate file is not valid UTF-8") from error
    identities: set[str] = set()
    fingerprints: set[str] = set()
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        fields = stripped.split()
        if len(fields) != 3:
            raise CredentialError("invalid_host_identity", "candidate file contains a malformed host-key line")
        identity, fingerprint = _decode_ed25519_key(fields[1], fields[2], error_code="invalid_host_identity")
        identities.add(identity)
        fingerprints.add(fingerprint)
    if len(identities) != 1 or len(fingerprints) != 1:
        raise CredentialError("invalid_host_identity", "candidate file must contain exactly one unique Ed25519 key")
    return identities.pop(), fingerprints.pop()


def _parse_known_hosts(content: bytes) -> list[tuple[str, str]]:
    try:
        lines = content.decode("utf-8").splitlines()
    except UnicodeError as error:
        raise CredentialError("host_identity_conflict", "project known-hosts is not valid UTF-8") from error
    parsed: list[tuple[str, str]] = []
    for line in lines:
        if not line:
            continue
        fields = line.split()
        if len(fields) != 3:
            raise CredentialError("host_identity_conflict", "project known-hosts contains a malformed entry")
        token = fields[0]
        if token.startswith("["):
            closing = token.rfind("]:")
            if closing <= 1 or not token[closing + 2 :].isdigit():
                raise CredentialError("host_identity_conflict", "project known-hosts contains a nonliteral token")
            host = token[1:closing]
            port = int(token[closing + 2 :])
            normalized, _, _ = _host_key_token(host, port, None)
            if token != normalized:
                raise CredentialError("host_identity_conflict", "project known-hosts contains a nonnormalized token")
        else:
            normalized = _validate_host_token_part("known-host-token", token, normalize_ipv6=True)
            if token != normalized:
                raise CredentialError("host_identity_conflict", "project known-hosts contains a nonnormalized token")
        identity, _ = _decode_ed25519_key(fields[1], fields[2], error_code="host_identity_conflict")
        parsed.append((token, identity))
    return parsed


def _locked_enroll(directory: Path, token: str, identity: str) -> Path:
    directory_flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        directory_flags |= os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        directory_flags |= os.O_NOFOLLOW
    try:
        directory_descriptor = os.open(directory, directory_flags)
    except OSError as error:
        raise CredentialError("unsafe_path", "could not safely open credential directory", path=str(directory)) from error
    temporary_name: str | None = None
    try:
        lock_flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            lock_flags |= os.O_NOFOLLOW
        try:
            lock_descriptor = os.open("known_hosts.lock", lock_flags, 0o600, dir_fd=directory_descriptor)
        except OSError as error:
            raise CredentialError("unsafe_path", "could not safely open known-hosts lock") from error
        try:
            lock_metadata = os.fstat(lock_descriptor)
            if not stat.S_ISREG(lock_metadata.st_mode):
                raise CredentialError("unsafe_path", "known-hosts lock must be a regular file")
            os.fchmod(lock_descriptor, 0o600)
            fcntl.flock(lock_descriptor, fcntl.LOCK_EX)

            existing = b""
            known_hosts_metadata: os.stat_result | None = None
            read_flags = os.O_RDONLY
            if hasattr(os, "O_NOFOLLOW"):
                read_flags |= os.O_NOFOLLOW
            try:
                known_hosts_descriptor = os.open("known_hosts", read_flags, dir_fd=directory_descriptor)
            except FileNotFoundError:
                pass
            except OSError as error:
                raise CredentialError("unsafe_path", "could not safely open project known-hosts") from error
            else:
                try:
                    known_hosts_metadata = os.fstat(known_hosts_descriptor)
                    if not stat.S_ISREG(known_hosts_metadata.st_mode):
                        raise CredentialError("unsafe_path", "project known-hosts must be a regular file")
                    if stat.S_IMODE(known_hosts_metadata.st_mode) != 0o600:
                        raise CredentialError("unsafe_permissions", "project known-hosts must have mode 0600")
                    with os.fdopen(known_hosts_descriptor, "rb", closefd=False) as stream:
                        existing = stream.read(MAX_CANDIDATE_BYTES + 1)
                    if len(existing) > MAX_CANDIDATE_BYTES:
                        raise CredentialError("host_identity_conflict", "project known-hosts is too large")
                finally:
                    os.close(known_hosts_descriptor)

            parsed = _parse_known_hosts(existing)
            matches = [stored_identity for stored_token, stored_identity in parsed if stored_token == token]
            if len(matches) > 1 or (matches and matches[0] != identity):
                raise CredentialError("host_identity_conflict", "project known-hosts contains a conflicting identity", token=token)
            if matches:
                return directory / "known_hosts"

            addition = f"{token} {identity}\n".encode("ascii")
            updated = existing + (b"" if not existing or existing.endswith(b"\n") else b"\n") + addition
            temporary_name = f".known_hosts.{uuid.uuid4()}.tmp"
            write_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                write_flags |= os.O_NOFOLLOW
            temporary_descriptor = os.open(temporary_name, write_flags, 0o600, dir_fd=directory_descriptor)
            try:
                with os.fdopen(temporary_descriptor, "wb", closefd=False) as stream:
                    stream.write(updated)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.fchmod(temporary_descriptor, 0o600)
            finally:
                os.close(temporary_descriptor)
            os.replace(
                temporary_name,
                "known_hosts",
                src_dir_fd=directory_descriptor,
                dst_dir_fd=directory_descriptor,
            )
            temporary_name = None
            os.fsync(directory_descriptor)
            return directory / "known_hosts"
        finally:
            os.close(lock_descriptor)
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name, dir_fd=directory_descriptor)
            except FileNotFoundError:
                pass
        os.close(directory_descriptor)


def enroll(
    credential_dir: str,
    provider: str,
    vm_name: str,
    creation_id: str,
    vm_uuid: str,
    fingerprint: str,
    guest_user: str,
    hostname: str,
    port: int,
    trusted_host_fingerprint: str,
    candidate_file: str,
    host_key_alias: str | None = None,
) -> dict[str, Any]:
    """Enroll one independently verified Ed25519 host identity under a locked project-local store."""
    verified = verify(credential_dir, provider, vm_name, creation_id, vm_uuid, fingerprint, guest_user)
    token, hostname, host_key_alias = _host_key_token(hostname, port, host_key_alias)
    trusted_host_fingerprint = _trusted_fingerprint(trusted_host_fingerprint)
    identity, candidate_fingerprint = _candidate_identity(candidate_file)
    if candidate_fingerprint != trusted_host_fingerprint:
        raise CredentialError(
            "host_identity_mismatch",
            "candidate host identity does not match the independently trusted fingerprint",
            token=token,
        )
    directory, _ = _load_record(credential_dir)
    known_hosts = _locked_enroll(directory, token, identity)
    return {
        **verified,
        "hostname": hostname,
        "port": port,
        "host_key_alias": host_key_alias,
        "host_key_token": token,
        "host_key_fingerprint": candidate_fingerprint,
        "known_hosts_path": str(known_hosts),
    }


def _project_root_for(directory: Path, record: dict[str, Any]) -> Path:
    try:
        if directory.name != record["creation_id"] or directory.parent.name != record["vm_name"]:
            raise ValueError
        if directory.parent.parent.name != "ssh" or directory.parent.parent.parent.name != ".libvirt-toolkit":
            raise ValueError
        return directory.parents[3]
    except (IndexError, ValueError) as error:
        raise CredentialError("unsafe_path", "credential directory is outside the project runtime layout") from error


def _quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _atomic_text(path: Path, content: str) -> None:
    if path.exists() or path.is_symlink():
        _safe_regular_file(path)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def configure(
    credential_dir: str,
    provider: str,
    vm_name: str,
    creation_id: str,
    vm_uuid: str,
    fingerprint: str,
    guest_user: str,
    hostname: str,
    port: int,
    known_hosts: str,
    host_key_alias: str | None = None,
) -> dict[str, Any]:
    """Write a strict standalone SSH config for an exact bound credential identity."""
    verified = verify(credential_dir, provider, vm_name, creation_id, vm_uuid, fingerprint, guest_user)
    directory, record = _load_record(credential_dir)
    project_root = _project_root_for(directory, record)
    lookup_name, hostname, host_key_alias = _host_key_token(hostname, port, host_key_alias)

    trust_store = _absolute_path("known-hosts", known_hosts)
    _validate_config_value("known-hosts", str(trust_store))
    _safe_regular_file(trust_store)
    try:
        trust_store.relative_to(project_root)
    except ValueError as error:
        raise CredentialError("unsafe_path", "known-hosts must be project-local", path=str(trust_store)) from error

    lookup = _run(["ssh-keygen", "-F", lookup_name, "-f", str(trust_store)], missing_ok=True)
    if lookup.returncode == 1 or not lookup.stdout.strip():
        raise CredentialError(
            "host_identity_missing",
            "known-hosts does not contain the required independently verified host identity",
            lookup=lookup_name,
        )

    private_key = verified["private_key_path"]
    for label, value in (("identity-file", private_key), ("known-hosts", str(trust_store))):
        _validate_config_value(label, value)
    lines = [
        f"Host {ALIAS}",
        f"  HostName {_quote(hostname)}",
        f"  Port {port}",
        f"  User {_quote(guest_user)}",
        f"  IdentityFile {_quote(private_key)}",
        "  IdentityAgent none",
        "  IdentitiesOnly yes",
        "  AddKeysToAgent no",
        "  BatchMode yes",
        "  PasswordAuthentication no",
        "  KbdInteractiveAuthentication no",
        "  PreferredAuthentications publickey",
        f"  UserKnownHostsFile {_quote(str(trust_store))}",
        "  GlobalKnownHostsFile /dev/null",
        "  StrictHostKeyChecking yes",
        "  CheckHostIP no",
        "  VerifyHostKeyDNS no",
        "  UpdateHostKeys no",
        "  KnownHostsCommand none",
        "  ControlMaster no",
        "  ControlPath none",
        "  ControlPersist no",
    ]
    if host_key_alias is not None:
        lines.append(f"  HostKeyAlias {_quote(host_key_alias)}")
    config_path = directory / "ssh_config"
    _atomic_text(config_path, "\n".join(lines) + "\n")
    return {**verified, "alias": ALIAS, "config_path": str(config_path), "hostname": hostname, "port": port}


def _add_identity_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--credential-dir", required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--vm-name", required=True)
    parser.add_argument("--creation-id", required=True)
    parser.add_argument("--vm-uuid", required=True)
    parser.add_argument("--fingerprint", required=True)
    parser.add_argument("--guest-user", required=True)


def _parser() -> JsonArgumentParser:
    parser = JsonArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="operation", required=True, parser_class=JsonArgumentParser)
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--project-root", required=True)
    prepare_parser.add_argument("--vm-name", required=True)
    prepare_parser.add_argument("--provider", required=True)
    prepare_parser.add_argument("--guest-user", required=True)
    for operation in ("bind", "verify"):
        _add_identity_arguments(subparsers.add_parser(operation))
    enroll_parser = subparsers.add_parser("enroll")
    _add_identity_arguments(enroll_parser)
    enroll_parser.add_argument("--hostname", required=True)
    enroll_parser.add_argument("--port", required=True, type=int)
    enroll_parser.add_argument("--trusted-host-fingerprint", required=True)
    enroll_parser.add_argument("--candidate-file", required=True)
    enroll_parser.add_argument("--host-key-alias")
    configure_parser = subparsers.add_parser("configure")
    _add_identity_arguments(configure_parser)
    configure_parser.add_argument("--hostname", required=True)
    configure_parser.add_argument("--port", required=True, type=int)
    configure_parser.add_argument("--known-hosts", required=True)
    configure_parser.add_argument("--host-key-alias")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    try:
        arguments = vars(_parser().parse_args(argv))
        operation = arguments.pop("operation")
        handler = {"prepare": prepare, "bind": bind, "verify": verify, "enroll": enroll, "configure": configure}[
            operation
        ]
        result = handler(**{name.replace("-", "_"): value for name, value in arguments.items()})
        print(json.dumps(result, sort_keys=True))
        return 0
    except CredentialError as error:
        print(json.dumps(error.payload(), sort_keys=True), file=sys.stderr)
        return error.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
