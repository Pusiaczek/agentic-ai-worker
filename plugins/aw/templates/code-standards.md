<!-- aw default code standards. The CLI adds this file to the coder's, tester's and reviewer's briefings
     (HTML comments stripped). Repository rules from .claude/aw/code-standards.md come after it and win where
     they conflict. Keep it short: every line is paid for in every briefing. -->

Code is read and reviewed by humans. Optimize for reading:

- **Descriptive names.** No single-letter variables outside one-line lambdas: `state`, `run`, `finding`, not `s`, `r`, `f`.
- **No nested ternaries.** Use `if`/`else`, a `switch`, or a lookup object such as `Record<Key, Value>`.
- **Name non-obvious conditions.** If a condition is repeated, or takes a moment to understand, make it a named function or constant with a short doc comment, ideally with an example.
- **Shared types over literals.** Reuse the project's existing types, enums and constants instead of repeating string literals or redefining unions. If a literal appears in more than one place, give it a name.
- **Typed code, tests included.** In TypeScript, no `any`. Type what you read (fixtures, JSON, responses) or use `unknown` and narrow it. Test helpers get descriptive names and types too.
