# Probing a pane's command

`template save` captures geometry, labels and dirs. It does not capture commands, and it says so in
its own help text:

> A capture recovers geometry, labels and dirs — NOT commands: no multiplexer can report the
> command a pane was launched with, so every pane is saved without one. Fill them in before
> the template is worth applying.

The same sentence is repeated in `template-capture.ts`'s module doc, in `convert`'s doc, in
`cli.ts:466`, and on the website at `cli/template.md`. This document tests it against the three
backends, with live binaries, and finds it **narrowly true but operationally misleading** — the
premise holds, the conclusion drawn from it does not.

Evidence gathered 2026-07-19 on Linux/WSL2 against herdr 0.7.4, tmux 3.6b, and wezterm
20240203-110809-5046fc22.

## The distinction the claim rests on

Three different questions get collapsed into one by the current wording:

1. **What command was this pane LAUNCHED with?** — the multiplexer's own spawn record.
2. **What command is RUNNING in it right now?** — the foreground process, whoever started it.
3. **What command, if re-run, RECONSTITUTES this pane?** — what a template actually needs.

The help text answers (1) and stops. But cyber-mux itself makes (1) structurally unanswerable, and
that is a fact about cyber-mux, not about multiplexers.

### Why (1) is dead by cyber-mux's own design

`template apply` never passes a template's `command` to the split. `applyTemplate` builds the whole
geometry first with no `launch`, then types every command in as text:

```
packages/cyber-mux/src/template-session.ts:681
        ctx.adapter.submit(ctx.exec, { id: tab.paneOf.get(pane)! }, command)
```

The reason is documented at `template-session.ts:562` — `open`'s `launch` couples creation to
launching, so a pane already running an interactive process cannot then be split. So every pane
cyber-mux creates is a bare shell that was *typed into*. tmux's `pane_start_command` is therefore
empty for every pane cyber-mux has ever made, and always will be. Round-tripping a template through
`apply` → `save` could never recover commands from a spawn record even if every backend kept a
perfect one.

That makes question (1) the wrong question. Question (2) is the one with answers.

## Per-backend capability matrix

| Backend     | Launched-with (1)                              | Running-now (2)                                             | Full argv? | Mechanism                                | Cost                     |
| ----------- | ---------------------------------------------- | ----------------------------------------------------------- | ---------- | ---------------------------------------- | ------------------------ |
| **herdr**   | ✗ — no field, `pane split` takes no command    | ✓✓ **native, full argv, whole foreground tree**              | **Yes**    | `herdr pane process-info --pane <id>`    | 1 CLI call per pane      |
| **tmux**    | ~ — `#{pane_start_command}`, tmux-spawned only | ~ — `#{pane_current_command}` is a bare process **name**     | Name only  | `list-panes -F`; `#{pane_pid}` + `/proc` | 1 call for all panes     |
| **wezterm** | ✗ — no field at all                            | ✗ — only `title`, free text, observed **stale and wrong**    | No         | `cli list --format json`; `tty_name` + `/proc` | 1 call for all panes |

Legend: ✓✓ native and high fidelity · ~ partial · ✗ absent.

## Evidence

### herdr — the claim is simply false here

`herdr pane process-info` is an undocumented-in-README but fully present CLI verb in 0.7.4:

```
$ herdr pane --help
  ...
  herdr pane process-info [--pane ID|--current]
```

Run against this very pane:

```
$ herdr pane process-info --pane w6W:p1
{"id":"cli:pane:process_info","result":{"process_info":{
  "foreground_process_group_id":730729,
  "foreground_processes":[
    {"argv":["claude"],"cmdline":"claude",
     "cwd":"/home/unional/code/cyberuni/cyber-mux.worktrees/legion-640022",
     "name":"claude","pid":730729}],
  "pane_id":"w6W:p1","shell_pid":730648},"type":"pane_process_info"}}
```

An idle pane reports its shell, unambiguously — `shell_pid` equals the foreground pid:

```
$ herdr pane process-info --pane w6A:p2
  "foreground_processes":[{"argv":["/usr/bin/zsh"],"cmdline":"/usr/bin/zsh",
                           "name":"zsh","pid":423449}],
  "shell_pid":423449
```

And a pane running a real toolchain reports the **entire foreground process tree**, each entry with
complete argv:

```
$ herdr pane process-info --pane w19:p3
  "foreground_processes":[
    {"argv":["node","/run/user/1000/fnm_multishells/4223_.../bin/nr","web","dev"], "pid":711689},
    {"argv":["node",".../bin/pnpm","run","web","dev"],                              "pid":711700},
    {"argv":["sh","-c","pnpm run --filter=website dev"],                            "pid":711713},
    {"argv":["node",".../bin/pnpm","run","--filter=website","dev"],                 "pid":711714},
    {"argv":["sh","-c","astro dev"],                                                "pid":711726},
    {"argv":["node",".../astro/bin/astro.mjs","dev"],                               "pid":711727},
    {"argv":[".../esbuild","--service=0.28.1","--ping"],                            "pid":711744}],
  "shell_pid":3141
```

herdr does the `/proc` walk for us, in-process, and hands back structured argv. This is strictly
better than anything tmux or wezterm expose. **On the backend the user actually runs, "no
multiplexer can report the command" is false.**

Note what the `w19:p3` output also proves, though — see *Observable vs recoverable* below. The user
typed `nr web dev`. The shallowest entry is `node /run/user/1000/fnm_multishells/…/bin/nr web dev`.
The literal text typed is **not** in there.

#### herdr bug: `process-info --current` ignores `$HERDR_PANE_ID`

Reproducible, twice in a row, from a pane that is not the focused one:

```
$ env | grep HERDR_PANE_ID
HERDR_PANE_ID=w6W:p1

$ herdr pane current --current      # → pane_id w6W:p1   (correct — honors the env)
$ herdr pane process-info --current # → pane_id w6C:p1   (wrong — the FOCUSED pane)
```

`pane current` resolves `--current` from `$HERDR_PANE_ID`; `process-info` resolves it from focus.
Any adapter code must pass `--pane <id>` explicitly and never rely on `--current` here. Worth filing
upstream against herdr 0.7.4.

### tmux — partial, and the useful half is unreachable for us

A probe server with four panes created four different ways:

```
$ tmux -L probe list-panes -a -F '#{pane_id}|start=[#{pane_start_command}]|cur=[#{pane_current_command}]|pid=#{pane_pid}'
%0|start=[]|cur=[zsh]|pid=732244                                                    # bare shell
%1|start=[]|cur=[zsh]|pid=732247                                                    # bare shell
%2|start=["sleep 300"]|cur=[sleep]|pid=732255                                       # split-window 'sleep 300'
%3|start=["python3 -u -c \"import time; time.sleep(300)\""]|cur=[python3]|pid=732263 # cmd with args
%4|start=[]|cur=[zsh]|pid=732271                                                    # bare shell, typed into later
```

- `pane_start_command` carries the **full command line with quoted args** — but only when tmux
  itself spawned it. For pane `%4`, after `send-keys 'python3 -u -c "…"' Enter`, it stayed **blank
  forever** while `pane_current_command` flipped to `python3`. That is exactly the cyber-mux case.
- `pane_current_command` is a bare process **name**. Never `claude --resume abc`; just `claude`.
  Never `node …/astro dev`; just `node`.
- `pane_start_command` is **not immutable**: `respawn-pane -t %3 'sleep 111'` overwrote it to
  `["sleep 111"]`.
- When a pane's process exits, tmux **destroys the pane** unless `remain-on-exit on`. With it set,
  the pane survives as `dead=1 dead_signal=15` and `pane_start_command` remains intact.
- The complete `pane_*` format set in 3.6b contains no argv or command-history variable beyond
  `pane_start_command` / `pane_current_command`.

Full argv on tmux requires `/proc` (below).

### wezterm — worse than tmux, and quietly so

`wezterm cli list` works headlessly (it auto-spawns `wezterm-mux-server`). Panes spawned bare, with
`spawn -- sleep 300`, and with a multi-arg python command:

```json
[{"window_id":0,"tab_id":0,"pane_id":0,"title":"zsh","cwd":"file:///home/unional","tty_name":"/dev/pts/17"},
 {"window_id":0,"tab_id":1,"pane_id":1,"title":"zsh","cwd":"file:///tmp","tty_name":"/dev/pts/19"},
 {"window_id":0,"tab_id":2,"pane_id":2,"title":"sleep","cwd":"file:///tmp","tty_name":"/dev/pts/21"},
 {"window_id":0,"tab_id":3,"pane_id":3,"title":"python3.14","cwd":"file:///tmp","tty_name":"/dev/pts/23"}]
```

The full field set is `window_id, tab_id, pane_id, workspace, size{…}, title, tab_title,
window_title, cwd, cursor_*, left_col, top_row, is_active, is_zoomed, tty_name`. **There is no
command, argv or cmdline field.** `title` is free text that happened to match the process name at
spawn.

Worse, `title` does not track the foreground process. After sending a python command into pane 1's
bare shell — verified actually running via `get-text` and `ps` (its own pid as `tpgid`) — the JSON
**still reported `"title": "zsh"`**. wezterm's title depends on shell-integration OSC sequences, so
without a configured prompt hook it silently reports the wrong thing. That is a failure mode worse
than reporting nothing: `pane_current_command` on tmux is *coarse*; wezterm's `title` is *stale*.

`wezterm cli --help` confirms no other subcommand exposes a command. The only route is `tty_name` +
`/proc`.

### `/proc` — the universal fallback, full fidelity, Linux only

From a tmux pane's `pane_pid` (a shell) to the running foreground command:

```
$ cat /proc/732271/task/732271/children
733680
$ tr '\0' ' ' < /proc/732271/cmdline
-zsh
$ tr '\0' ' ' < /proc/733680/cmdline
python3 -u -c import time; time.sleep(250)
$ awk '{print $8}' /proc/732271/stat        # field 8 = tpgid, the tty foreground pgrp
733680
```

`tpgid` from `/proc/<shell_pid>/stat` is the robust primitive — it is the kernel's own answer to
"what owns the terminal right now", independent of the multiplexer. `/proc/<pid>/cmdline` then gives
complete argv. The same works from wezterm's `tty_name`:

```
$ ps -eo pid,tty,tpgid | awk '$2=="pts/23"{print $3}'   →  pid
$ tr '\0' ' ' < /proc/<pid>/cmdline
python3 -u -c import time; time.sleep(300)
```

Observed limits: Linux/procfs only (no macOS equivalent — untested there, would need `libproc`);
requires read permission on the target pid (fine same-user, fails across users); and it reports
**this instant only** — nothing is recoverable once the process has exited. It answers question (2),
never question (1).

## Shell history — rejected

Considered and dismissed for the "last run" case. Reading `~/.zsh_history` or `~/.bash_history`
would let cyber-mux name a command in an idle pane. It should not:

- **Not per-pane.** History is per *user*, appended by whichever shell exits or flushes first.
  Attributing an entry to a pane is guesswork, and wrong across concurrent panes — the common case
  in this repo's own workflow.
- **Not synchronized.** With default `zsh` settings, history is written on exit. A live pane's most
  recent command is frequently not in the file at all.
- **A privacy hazard.** Shell history routinely contains secrets typed inline, paths that identify
  people, and commands from entirely unrelated work. `template save` writes a file the user is
  expected to commit and share. Scraping history into it would exfiltrate by default.

A tool that reads a user's shell history to guess at their pane content is doing something the user
did not ask for. Not worth a marginal fidelity gain over `process-info`.

## Observable vs recoverable

This is the part that decides the recommendation.

`process-info` answers "what process is alive right now". A template needs "what command, re-run,
reconstitutes this pane". Those coincide less often than they look:

| Pane state                    | Observable                                            | Belongs in a template?               |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------ |
| idle shell                    | `zsh`                                                 | **No** — a pane with no command *is* an idle shell |
| `claude` running              | `claude`                                              | Maybe — loses `--resume <id>`, `-p`, any flag |
| `nr web dev` via fnm shim     | `node /run/user/1000/fnm_multishells/…/bin/nr web dev` | **No** — machine-local path, dead on any other host |
| `pnpm dev` (7-deep tree)      | seven entries, deepest is `esbuild --service=0.28.1`   | Only the shallowest, and even that is shimmed |
| `sudo …` / `ssh host …`       | argv of the wrapper, credentials possibly inline       | **No** — leaks, and wrong to re-run |
| `vim src/foo.ts`              | `nvim` (herdr) / `nvim` (tmux name)                    | Marginal — loses the file            |

Three systematic distortions, all visible in the evidence above:

1. **Resolved, not typed.** argv is post-`$PATH`, post-alias, post-shim. `nr web dev` never appears;
   `node /run/user/1000/fnm_multishells/4223_1784479278417/bin/nr web dev` does. That path contains a
   uid, a pid and a timestamp. It is not portable to the next machine, or even the next login.
2. **The tree has no canonical member.** herdr returns seven processes for one pane. The shallowest
   is the closest thing to "the command", but it is a heuristic, not a fact the backend asserts.
3. **Agent TUIs are the target case and the worst case.** A `claude` pane is where the whole feature
   would earn its keep, and argv is exactly `["claude"]` — the flags that made it *this* session live
   in a session id the template cannot carry anyway.

So: commands are **observable** on herdr with high fidelity, and only **partly recoverable** on any
backend. The gap is not a mechanism gap. It is that argv and a re-runnable command are different
things.

## Verdict on the help text

**The claim is technically true and practically misleading.** Two separate problems:

1. *"no multiplexer can report the command a pane was launched with"* — true as literally worded, and
   the module doc's own reasoning (`template-capture.ts:9-19`) is sound. But it buries why: cyber-mux
   makes it structurally unanswerable by submitting commands as text. That is our choice, not a
   limitation of tmux.
2. *"so every pane is saved without one"* — **does not follow**, and reads as "there is nothing to be
   had here", which is false. herdr reports full argv for every pane's foreground tree, natively, in
   one call. The reason not to capture is that argv is not a re-runnable command, not that argv is
   unavailable.

### Applied wording

**Status: landed.** All four sites were reworded to the PORTABILITY framing rather than the
availability one — the claim is no longer "no multiplexer can report it" but "what a backend reports
is a resolved, machine-local command line, not a portable one". The `nr web dev` →
`node /run/user/1000/fnm_multishells/…/bin/nr web dev` example carries the point at every site,
because a uid-and-timestamp path is self-evidently not something to check in.

The drafts below are what was proposed; the shipped text differs in wording but not in substance.

### Proposed wording (superseded by the above)

For `cli.ts:497`:

```
A capture recovers geometry, labels and dirs — NOT commands. cyber-mux types a template's
commands in rather than launching panes with them, so no backend holds a launch record to
give back; what a backend can report is the process running NOW, which is resolved argv
(`node /run/.../nr web dev`, never the `nr web dev` you typed) and is not re-runnable
anywhere else. Fill the commands in before the template is worth applying.
```

For `template-capture.ts:294` (`convert`'s doc), replacing "no multiplexer reports the command a pane
was launched with":

```
`command` is never emitted and there is no branch here that could emit one. cyber-mux submits
commands as text rather than launching with them, so no backend holds a launch record; and the
running-process argv a backend CAN report (herdr's `pane process-info` gives full argv) is the
resolved, shimmed, machine-local command line, not the one worth writing into a portable
template. A capture at any tier is a DRAFT with `command` left for the author.
```

The same correction applies to the module doc at `template-capture.ts:9-19`, `cli.ts:466`, and
`apps/website/src/content/docs/cli/template.md:66-67`.

## Recommendation

**Do not capture commands into the template body. Do surface them as a comment-grade hint.**

Reasons, in order of weight:

1. **A wrong `command` is worse than an absent one.** `template apply` submits `command` verbatim.
   Capturing `node /run/user/1000/fnm_multishells/4223_1784479278417/bin/nr web dev` produces a
   template that fails on the next login of the same machine — and fails *by executing something*,
   which is the failure mode with the worst blast radius. The current design's absent-rather-than-
   false rule (already stated for `label` in `toPaneNode`) points the same way here.
2. **The common pane captures as noise.** Most panes in a saved workspace are idle shells. Writing
   `command: /usr/bin/zsh` into every one of them makes the template *worse* than leaving them
   blank, and the author now has to delete lines rather than fill them.
3. **The one pane worth capturing captures worst.** `claude` is `["claude"]` — the flags are gone.
4. **Two of three backends can't do it well anyway.** tmux gives a process name; wezterm gives a
   stale title. A feature that only works on one backend and only sometimes belongs behind a
   different affordance than a schema field.

### What to build instead

Emit what was observed as a **warning**, using the channel `TemplateCapture.warnings` already
provides — the exact mechanism `toPaneNode` uses for an out-of-root `cwd`:

```
pane w19:p3 is running `node …/nr web dev` — captured without a command, because a running
process's argv is not a portable launch command. Set `command:` by hand if this pane should
re-run it.
```

The author gets the fact, in context, next to the pane it belongs to, without it landing in a file
that will later be executed.

### The seam, if this is pursued

Minimal and additive. Nothing on the apply path changes.

1. **`RegionPane` grows one optional field** (`session.ts:232`):

   ```ts
   /**
    * The foreground command running in this pane, when the backend can report it — resolved argv,
    * NOT a launch command. Absent when the pane is an idle shell or the backend cannot say.
    */
   running?: string
   ```

   Optional, so tmux and wezterm adapters need no change to compile, and `describeRegion`'s existing
   best-effort contract carries over unmodified.

2. **`session.herdr.ts` fills it.** One `herdr pane process-info --pane <id>` per pane in
   `herdrPaneDetails`. Take the **shallowest** entry of `foreground_processes`; drop it entirely when
   its pid equals `shell_pid` (that is the idle-shell case, and the equality is an exact test, not a
   heuristic — verified on `w6A:p2` above). Must pass `--pane` explicitly; `--current` is broken.

   Cost: N extra CLI calls for an N-pane capture, against the 2 that `describeRegion` makes today.
   `save` is interactive and one-shot, so this is acceptable; if it is not, it is a flag.

3. **Fallback ladder** — deliberately short, in strict preference order:
   - herdr: `pane process-info` → shallowest foreground process argv.
   - tmux: `#{pane_current_command}` only if it differs from the pane's shell. **Do not** add a
     `/proc` walk — it is Linux-only, it would put an OS-specific branch inside an adapter whose
     whole design is a synchronous `Exec` over a CLI, and it buys a coarse name a warning does not
     need to be precise about. Reconsider only if `running` ever becomes load-bearing.
   - wezterm: **nothing**. `title` is demonstrably stale; reporting it would be reporting a lie.
   - Anything else, and every idle shell: field absent.

4. **`template-capture.ts` reads it and warns.** `toPaneNode` pushes a warning when `pane.running`
   is set; `convert` still has no branch that emits `command`, and its doc says why. The purity of
   the module is untouched — `running` arrives on `RegionPane` like `cwd` and `label` do.

5. **`template save` prints the warnings it already prints.** No CLI surface change at all.

Estimated cost: about half a day, most of it the herdr adapter's JSON parsing plus tests with a
mocked `Exec`. No schema change, no changeset-visible behavior change beyond extra warning lines.

### If the answer is instead "capture it behind a flag"

A `template save --capture-commands` that writes `command:` anyway is defensible only if the emitted
template is marked as machine-local. It is not recommended: it produces a file that looks portable,
is not, and executes on apply. The warning channel gives the author the same information with none of
that risk.
