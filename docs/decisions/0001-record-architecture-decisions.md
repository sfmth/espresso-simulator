# 0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Puckworks is a long, multi-milestone project. Its product decisions are locked in [PLAN.md §2](../PLAN.md#2-locked-decisions-2026-10-13). The implementation choices behind them (languages, numerics, hosting, data formats) also need written reasons. Future contributors, including AI assistants that start without context, would otherwise re-open settled questions or silently undo them.

## Decision

- Each implementation decision gets a numbered Markdown file in `docs/decisions/`, listed in its README.
- A record has five parts: Status, Context, Decision, Consequences, Alternatives considered. Measurements behind a decision go in the record.
- Records are never rewritten to change a decision. A new record supersedes the old one, which is marked "Superseded by NNNN".

## Consequences

- Reviewers can check a change against the recorded reasons instead of reconstructing them.
- Writing a record costs a little time per decision. Small, local choices stay in code comments.

## Alternatives considered

- **Decisions only in PLAN.md.** That would mix product scope with implementation detail and make the plan harder to read.
- **Decisions only in commit messages.** They are hard to find, and the owner manages git manually, outside the tooling.
