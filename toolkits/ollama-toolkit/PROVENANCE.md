# Provenance

The naming workflow is adapted from the user's original
[`lib/ollama_name_cleanup.py`](https://github.com/dotknewt/linux-dotfiles/blob/3be5a2d9a36332238f616618f7eaa80e0176ab5f/lib/ollama_name_cleanup.py)
in `dotknewt/linux-dotfiles`, source commit
`3be5a2d9a36332238f616618f7eaa80e0176ab5f`.

On 2026-10-29 the user explicitly confirmed ownership of the original script
and authorized its adaptation and redistribution under MIT for this toolkit.
This is the authorization basis, not an inference about the source repository's
general license. This toolkit is distributed under the repository MIT LICENSE.

The bundled core adapts extraction and renaming into an injectable, bounded CLI
workflow with conservative verification and structured failures. The new MCP
surface, protocol tests, manifest, and skill follow this repository's native
toolkit conventions. No libvirt implementation is imported. The source script
is unchanged and is not a runtime dependency.

The PEP 723 entrypoint declares `mcp==2.2.0`; uv resolves it at runtime rather
than vendoring it. Its dependencies retain their respective licenses.
