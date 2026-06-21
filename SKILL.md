---
name: safescript
description: Write and run safescript programs. Safescript is a sandboxed language with static analysis — before code runs, you can see exactly which hosts it contacts, which secrets it reads/writes, and its resource bounds.
---

# Safescript

A sandboxed language with static analysis designed for secure automation. Every program is statically analyzed before execution, so you always know what network hosts it contacts, what secrets it reads or writes, and its resource bounds.

## Quick Start
Use `analyze_safescript` to inspect a script before running it. Use `run_safescript` to execute a function from a script. Community skills may also expose individual safescript functions as callable tools directly.

## References
You MUST call `read_skill_reference` to load the full language syntax reference before writing or analyzing any Safescript code:
- `safescript-language-reference.md`: Complete Safescript syntax, built-ins, and library contract specifications.
