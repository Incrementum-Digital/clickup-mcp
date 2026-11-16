# Time tracking

## Sub-features
- `getTimeEntries` (by `task_id`, `list_id`, `space_id`, date range, `include_all_users`), `getRunningTimer`.
- `createTimeEntry` (`hours`, `start_time`, `description`, `billable`), `startTimer`, `stopTimer` (write mode).

## How to get to it (user POV)
"Book 2 hours on the client meeting", "how much time did I spend on development this week", "start a timer on CU-abc123".

## Driving it with the CLI
Read-only by hand: `just cli getRunningTimer` or `just cli getTimeEntries start_date=2026-11-01 end_date=2026-11-16`. Not in the verify drive by default.

## Gotchas
- Entries are per user; `include_all_users` needs the right ClickUp role.
- A running timer belongs to the token's user; stopping it in a drive would change real time data, so never call `stopTimer` in verification.
