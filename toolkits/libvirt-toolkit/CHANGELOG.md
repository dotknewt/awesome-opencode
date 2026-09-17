# Changelog

## 0.2.0 - 2026-09-17

- Added a self-contained project credential helper with distinct local
  `creation_id` and provider-returned VM UUID binding, strict generated SSH
  configuration, and pending-state recovery semantics.
- Added optional creation-time guest access to `vm_create`: one Ed25519 public
  key completely replaces the selected account's `authorized_keys` in the new
  overlay before domain definition, with account/fingerprint metadata preserved
  through powered-off snapshots.
- Updated Ubuntu, Debian 13, and CachyOS preparation contracts to disable
  cloud-init key rewriting, remove shared login keys, assert exact SSH policy,
  and regenerate host keys independently before SSH starts.
- Required project-config-only SSH/SCP/rsync use, independent host-key trust,
  explicit routed management configuration, and safe transfer exclusion of
  `/.libvirt-toolkit/`.
- Added locked, no-follow helper enrollment for independently verified Ed25519
  guest host keys, including normalized direct, literal-IPv6, and tunnel-alias
  lookup tokens without personal known-hosts fallback.
- Extended installed-package acceptance for the helper and artifact exclusions;
  documented conditional libguestfs, OpenSSH, and helper dependencies.

## 0.1.0 - 2026-09-16

- Migrated `libvirt-toolkit` 1.0.7 into a self-contained native OpenCode toolkit
  so installed skills and MCP assets no longer depend on a marketplace checkout.
- Namespaced both skills and the MCP connection to avoid collisions in consumer
  projects while preserving lifecycle, safety, recovery, and guest-access
  semantics.
- Added a strict versioned manifest so a later installation engine can resolve
  exports and the destination-relative MCP entrypoint without inventing OpenCode
  configuration fields.
