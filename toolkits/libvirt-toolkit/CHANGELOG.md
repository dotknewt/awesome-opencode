# Changelog

## 0.1.0 - 2026-09-16

- Migrated `libvirt-toolkit` 1.0.7 into a self-contained native OpenCode toolkit
  so installed skills and MCP assets no longer depend on a marketplace checkout.
- Namespaced both skills and the MCP connection to avoid collisions in consumer
  projects while preserving lifecycle, safety, recovery, and guest-access
  semantics.
- Added a strict versioned manifest so a later installation engine can resolve
  exports and the destination-relative MCP entrypoint without inventing OpenCode
  configuration fields.
