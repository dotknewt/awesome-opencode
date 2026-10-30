# Backlog
- [ ] Simplify installation/updating; current `awesome-opencode install <toolkit> <scope>` is not transparrent and knowing what each toolkit contains is hidden. 

- [ ] Make a standard location where any and every plugin,skill or agent can write (temp files, cache etc) outside the project directory can do so, without asking for permission

- [ ] List locations (directories, files) outside the project directory that can be read without asking for permission.

- **AO-001 — Restore isolated OpenCode discovery compatibility** (ready). Investigate the discovery check's reliance on `opencode --pure`, which the installed OpenCode CLI no longer advertises. Update the isolated-discovery acceptance path for a supported OpenCode version without weakening its isolation guarantees. Acceptance: `bun run test:opencode:discovery` passes with an actual supported OpenCode executable and continues to fail when discovery cannot be established. Dependency: determine the installed CLI's supported isolation options. This is separate from the Bun-default migration and is not authorized for implementation yet.
