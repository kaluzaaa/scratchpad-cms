# CLAUDE.md

Rules for this repository.

## Communication

- **Always communicate in the user's language**, but **everything is written in English** (code, comments, docs, commit messages, file contents).

## Working principles

- **Think Before Coding** — Don't assume. Don't hide confusion. Surface tradeoffs.
- **Simplicity First** — Minimum code that solves the problem. Nothing speculative.
- **Surgical Changes** — Touch only what you must. Clean up only your own mess.
- **Goal-Driven Execution** — Define success criteria. Loop until verified.

## Coding principles

- **KISS** — the simplest thing that works.
- **YAGNI** — don't build what isn't asked for.
- **SRP** — one reason to change per unit.
- **DRY** — one source of truth; don't duplicate logic.

## Execution principles

- **Internet research is always done via a subagent — never directly.**
- **Coding is always done via a subagent, passing it the rules from above** (the rules in this file).

## Planning

- **Every plan is always saved to `docs/plan/XX-<slug>.md`** (`XX` = zero-padded sequence number, `<slug>` = kebab-case name).
- **The end of every plan must always contain a checklist** of tasks to do, in the `- [ ]` format.
- **Every task gets its own separate commit.** The coding subagent, before committing, marks the task as done in the checklist (`- [x]`) and commits everything for that one task together.
