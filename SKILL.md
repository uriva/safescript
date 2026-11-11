---
name: safescript
description: Write and run safescript programs. Safescript is a sandboxed language with static analysis — before code runs, you can see exactly which hosts it contacts, which secrets it reads/writes, and its resource bounds.
---

# Safescript

A sandboxed, statically verified language designed for secure automation. Every program compiles to a static DAG before execution, proving which network hosts it contacts, how data flows, and its resource and complexity bounds.

## Quick Start
Use `analyze_safescript` to inspect a script's static signature before running it, and `run_safescript` to execute a function. Installed skills may also expose Safescript functions directly as callable tools.

## References
Load the `safescript-language-reference` (`references/safescript-language-reference.md`) before writing or analyzing any Safescript code:
- `safescript-language-reference.md`: Complete Safescript syntax, JS/TS differences, and built-in operations reference.
