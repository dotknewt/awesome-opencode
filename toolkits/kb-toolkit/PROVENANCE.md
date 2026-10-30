# Provenance

This toolkit is original implementation for `awesome-opencode`, distributed under
the repository MIT license. Its layout follows the repository's native toolkit
manifest and self-contained MCP conventions.

The publication contract was source-inspected against an operator-provided
Markdown KB. No private records, evidence files, source-root paths or approval
artifacts are bundled. Tests use synthetic temporary records. Index membership
is the operator-approved eligibility rule, not independently verified provenance.

`mcp==2.2.0` and `PyYAML==6.0.3` are declared through PEP 723 and resolved by uv,
not vendored. Dependencies retain their own licenses. The pinned SDK's low-level
resource URI behavior was experimentally measured before implementation; product
tests separately cover stdio behavior on Python 3.10 and 3.13.
