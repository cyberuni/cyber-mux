---
"cyber-mux": minor
---

Split the turn-driving verbs so that typing text and pressing keys are separate intents, and only `submit` supplies an Enter.

**Breaking.** `cyber-mux send <pane> <text>` and `SessionAdapter.send()` are gone, replaced by:

- `cyber-mux send text <pane> <text>` / `sendText()` — type literal characters, press no Enter. Text that happens to name a key (`Enter`, `Up`) is typed, never interpreted as that key.
- `cyber-mux send keys <pane> <keys...>` / `sendKeys()` — press named keys in order, typing nothing. Keys use a portable core vocabulary (`Up` `Down` `Left` `Right` `Enter` `Escape` `Tab` `Space` `Backspace` `C-c` `F1`–`F12`) normalized per backend; anything outside it is forwarded to the backend as-is.
- `cyber-mux submit <pane> [text]` / `submit(exec, target, text?)` — gains the optional text `send` used to have: types it, then always presses Enter. With no text (or empty text) it keeps its existing bare-Enter flush, which retypes nothing.

This fixes a real fault. `send`/`submit` previously passed text straight to `tmux send-keys`, which resolves each argument as a key name before falling back to characters — so submitting text that named a key pressed that key instead of typing it. Submitting `Up` pressed the arrow, recalling the pane's previous command from shell history, and the trailing Enter then **re-ran it**. Typing now goes through `send-keys -l`, which disables key-name lookup.

Migration: `send(exec, t, text)` → `submit(exec, t, text)` for taking a turn; `submit(exec, t)` is unchanged. On the CLI, `cyber-mux send <pane> <text>` → `cyber-mux submit <pane> <text>`. Bare `cyber-mux send` is now a command group: with no subcommand it prints help to stderr and exits 1.
