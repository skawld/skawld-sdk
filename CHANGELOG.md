# Changelog

All notable changes to `@skawld/agent-sdk` are documented here.

## [0.2.0] — 2026-06-13

### Added

- **AskUser tool** — Agents can now pause mid-run to elicit structured input from the user. Supports single-select, multi-select, and free-text responses with a 1–4 question format, option validation, and graceful decline handling.
- **Hooks system** — Introduced a first-class hook API (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `PreCompact`) that allows consumers to intercept, modify, or block agent actions at runtime without modifying core loop logic.

### Improved

- Hardened abort signal propagation across parallel tool execution, ensuring in-flight tool calls emit proper `tool_call_end` events before surfacing `AbortError`.
- Improved adjacent-batch partitioning in the tool scheduler to preserve strict result ordering across mixed read/write batches.
- Strengthened session store concurrency guarantees; concurrent `updateMeta` calls now correctly accumulate all patches without loss.
- Expanded provider error normalization for OpenAI Chat and Responses APIs, covering HTTP-date `retry-after` headers and mid-stream abort detection.
- Refined compaction logic to correctly re-inject skill listings and invoked skill bodies after context threshold is crossed.

## [0.1.0] — 2026-06-01

Initial release.
