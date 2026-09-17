# project-toolkit

Native OpenCode project-workflow instructions for handling TODO and backlog
items. Version `0.1.0` contributes the `dotknewt-handling-todos` skill and no MCP
server or always-loaded rules.

## Install and use

Choose exactly one target selector. For a project target:

```sh
awesome-opencode install project-toolkit --project /absolute/project
awesome-opencode update project-toolkit --project /absolute/project
awesome-opencode uninstall project-toolkit --project /absolute/project
```

For the global OpenCode configuration target:

```sh
awesome-opencode install project-toolkit --global
awesome-opencode update project-toolkit --global
awesome-opencode uninstall project-toolkit --global
```

Restart OpenCode after an applied install, update, or uninstall. Once installed,
OpenCode discovers `dotknewt-handling-todos` and loads it on demand when TODO or
backlog work matches its description. The toolkit does not edit consumer
`AGENTS.md`, inject instructions into configuration, or create an always-loaded
rule.

The installer owns only the manifest-declared skill files. Unrelated consumer
configuration and files remain untouched, and a local edit to an owned skill is
a conflict rather than permission to overwrite it.
