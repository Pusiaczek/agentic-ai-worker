<!-- aw default code standards. The CLI adds this file to the coder's, tester's and reviewer's briefings
     (HTML comments stripped). Repository rules from .claude/aw/code-standards.md come after it and win where
     they conflict. Keep it short: every line is paid for in every briefing. -->

Code is read and reviewed by humans. Optimize for reading:

- **Descriptive names.** No single-letter variables outside one-line lambdas: `state`, `run`, `finding`, not `s`, `r`, `f`.
- **No nested ternaries.** Use `if`/`else`, a `switch`, or a lookup object such as `Record<Key, Value>`.
- **Name non-obvious conditions.** If a condition is repeated, or takes a moment to understand, make it a named function or constant with a short doc comment, ideally with an example.
- **Shared types over literals.** Reuse the project's existing types, enums and constants instead of repeating string literals or redefining unions. If a literal appears in more than one place, give it a name. When a value must be one of a known set, especially a name that has to match something outside the type system (database constraint and index names, error codes, event names), declare the set once as an `as const` object, derive the union type from it, and type parameters with that union, not `string`. A typo is then a compile error. Give such external objects explicit names instead of relying on generated ones.
- **Typed code, tests included.** In TypeScript, no `any`. Type what you read (fixtures, JSON, responses) or use `unknown` and narrow it. Test helpers get descriptive names and types too.
- **One job per file, readable top-down.** A reader should see what a file does without wading through unrelated detail. Code with its own logic and its own reasons (validator setup, an error handler, a database helper, a non-trivial mapping) goes into its own module named after what it does, and the original file just calls it. Entry and composition files only wire things together. Don't over-split either: a few-line helper used in one place stays where it is.
- **Comment workarounds: why, and the assumption behind them.** Where code works around how a library, framework or database behaves, a short comment says why and what assumption it relies on, so whoever breaks that assumption knows to revisit it (e.g. "the API is JSON-only; form bodies would need coercion"). Without it, someone "simplifies" the workaround away.
- **Handle only errors you can identify.** Catch an error only to handle a case you can identify precisely (e.g. a database error code plus constraint name) and rethrow everything else. Never a catch-all that turns unknown errors into a normal result, such as a 4xx response: it disguises an outage or a bug.
