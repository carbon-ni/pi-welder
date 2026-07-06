# Clean leaked grammar tokens from parsed tool-call args

## Problem
Some models leak parser grammar markers into already-parsed tool-call argument keys/values, e.g. `<arg_key>command` or `<arg_value>ls`.

## Goal
Safely strip known grammar marker prefixes/suffixes from tool-call argument structure before validation/repair, without promoting assistant text into executable tool calls.

## Scope
- Add tests first for key cleanup and string value cleanup.
- Support known safe markers only, e.g. `<arg_key>`, `</arg_key>`, `<arg_value>`, `</arg_value>`.
- Apply recursively to object keys and scalar string values.
- Keep content-field safety: do not rewrite content payloads such as `command`, `oldText`, `newText`, `prompt`, `content` unless tests define exact safe behavior.

## Acceptance Criteria
- Parsed arg key `<arg_key>command` becomes `command`.
- Parsed arg value `<arg_value>true</arg_value>` is stripped before normal type coercion where safe.
- Content fields remain unchanged unless explicitly tested.
- `npm test` and `npm run lint` pass.

## Out of Scope
- Full grammar recovery.
- Converting assistant text into `toolCall` blocks.
- Model/vendor parser matrix.
