---
"cyber-mux": minor
---

A failed backend command now says **why** it failed, in the backend's own words: `Exec` gained an optional `lastError`, and every adapter throw site that runs a command carries it through.

**The gap.** `realExec` ran with `stdio: ['ignore', 'pipe', 'ignore']` and mapped any failure to `null`, so a backend's stderr was discarded **by the seam itself**. Asking for a pane pool too large for the terminal got you:

```
tmux split-window failed
```

while tmux was saying `no space for new pane` the whole time, to a stream nobody read. The failure was *correct* — the walk stops, reports the panes it built, exits 1, kills nothing — but gave the caller nothing to act on.

**The change.**

- `Exec` is now a callable interface rather than a bare function type, carrying an optional `lastError?: string` — the reason the most recent call returned `null`. **A plain arrow function still satisfies it**, so every existing call site and every test fake is unchanged; a runner that never sets it degrades to no reason at all.
- `realExec` captures stderr and records it, **clearing it on every success** so a reason can never outlive the command that produced it.
- `withReason(exec, message)` (new, from `exec.ts`) appends the reason when there is one. The eight adapter throw sites that run a command use it.

```
tmux split-window failed — no space for new pane
```

**Why a mutable field and not a result object.** Widening the return to `{ ok, stdout, stderr }` is the tidier seam, and it rewrites 45 production call sites and 40 test fakes for a diagnostic. `Exec` is **synchronous by construction** (`execFileSync`), so "the most recent call" is unambiguous and a throw site reads it on the line after the call that set it. Forwarding stderr to the terminal instead was rejected for a concrete reason: `exists` and the multiplexer probe run commands that fail **routinely**, so it would spam every normal run.

**Deliberately not everywhere.** `lastError` is a diagnostic, never a control-flow signal — `null` remains the only failure sentinel. Sites that do not run a command do not use it: resolving a pane id out of `list-panes` output is a parse failure, not a command failure, so attributing the runner's most recent reason there would be a confident lie. `send keys` still does not read it, so an unknown key still exits 0 on both backends.

No behavior changes for a command that succeeds, and no error message changes for a runner that reports no reason.
