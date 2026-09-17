# ADR 0002: Owned, transactional installation

Status: accepted (2026-09-16)

## Decision

Record single-toolkit file ownership with hashes/modes and per-entry structural
configuration ownership. Refuse unowned or modified collisions. Preflight all
changes, use an fsynced before/after journal, guard rollback/recovery, and retain
an exclusive util-linux `flock` through a parent-owned inherited descriptor.

## Consequences

The installer fails safely instead of adopting or overwriting local content.
Interrupted work is recoverable only while resources still match recorded states.
Linux and util-linux `flock` are mutation prerequisites. Dry-run remains zero
write, including when recovery is pending.
