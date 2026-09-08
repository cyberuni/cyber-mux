---
'cyber-mux': patch
---

Stop sending `--cwd` on `otty tab new`, and keep it on `otty pane split` — where otty's own docs show
it.

Issue #163 read otty's CLI reference, found no `--cwd` anywhere on it, and concluded the adapter was
sending a fabricated flag on both routes. Only half of that is right. otty's
[orchestration guide](https://docs.otty.sh/agents/orchestration) runs
`otty pane split --direction right --cwd "$PWD" --no-focus --json` as a command you can type by hand,
so the split route's `--cwd` is documented by otty itself and is unchanged. The reference's
`window / tab / pane` section carries no flag table at all — measured across all 141 URLs in
`docs.otty.sh/sitemap.xml`, `--cwd` and `--no-focus` each appear on exactly one page, and it is not
the reference.

`tab new` has no such backing: nothing otty publishes puts a working directory on it, and otty ships
no source to settle it either way. The costs of the two readings are not symmetric — if the flag
exists, a `cd` works too; if it does not, `--cwd` fails **every** `--at tab` open at otty's argument
parser. So the tab route drops the flag and carries the directory as a `cd` on the command line, the
same shape cmux's `pane:*` route takes, with the env prefix inside the `&&`. It is a shell-level cd,
so it lands in that tab's shell history and means nothing in a non-shell pane. The `cd` needs no
launch command to ride, so a tab opened with a `cwd` and no `launch` still lands in the right
directory. The workspace tier was never affected — `otty open [path]` takes the directory as a
documented positional.

Read off otty's published docs, NOT verified against a live binary — otty is a macOS/Windows GUI app
absent from the machine this was written on, and #128 tracks the missing real-boundary suite.
