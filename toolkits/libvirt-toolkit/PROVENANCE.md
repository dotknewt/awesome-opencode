# Provenance

This toolkit was migrated from `dotknewt/awesome-agency` at Git revision
`36026a3619af7e38273e40ccf4266125c31d1f79` on 2026-09-16.

| Native content | Source | Source version |
|---|---|---|
| `mcp/libvirt/` | `plugins/libvirt-toolkit/mcp/libvirt/` | `libvirt-toolkit` 1.0.7 |
| `skills/dotknewt-libvirt-vms/` | `skills/libvirt-vms/` | included by `libvirt-toolkit` 1.0.7 |
| `skills/dotknewt-guest-access/` | `skills/guest-access/` | included by `libvirt-toolkit` 1.0.7 |

The source plugin manifest identifies the author as **dotKnewt** and declares
the source license as **MIT**. No separate copyright notice, SPDX header, or
license file was present in the inspected plugin, MCP server, or skill source;
this record therefore preserves the available author and license evidence
without inventing a copyright holder or notice.

The repository root `LICENSE` includes the declared MIT grant and explicitly
records that the inspected source supplied no copyright notice. It does not
infer a copyright holder from the manifest author field.

Migration changes are limited to native namespacing, references to those
namespaced skills and MCP connection, installed-layout documentation, and the
new toolkit packaging documents. Python implementation and tests are otherwise
copied unchanged; generated `__pycache__` and `.pyc` files are excluded.
