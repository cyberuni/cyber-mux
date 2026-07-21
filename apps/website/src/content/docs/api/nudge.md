---
title: nudge
description: Submit a message and verify the peer actually took its turn — recovering a swallowed Enter.
---

`nudge` is `submit` with a receipt. A booting harness can swallow the Enter of a plain
[`submit`](/cyber-mux/api/mux-adapter/#driving-a-pane), leaving your message staged unsent while the
call reports success. `nudge` sends the message, reads the pane back, and — if the text is still
sitting staged — flushes it with bare Enters until the turn is taken or a cap is hit.

The preferred call is the `MuxSession` method, `Exec` already bound:

```ts
import { resolveMux, type NudgeResult } from 'cyber-mux'

const mux = resolveMux(process.env)
const result = await mux.nudge(target, 'run the tests')
// result: { taken: true, resubmits: 2 }
```

`nudge` also stays exported as a free function over the raw, exec-first
[`MuxAdapter`](/cyber-mux/api/mux-adapter/#the-raw-seam), for a caller threading its own runner:

```ts
import { nudge, resolveMuxAdapter, nodeExec, type NudgeResult } from 'cyber-mux'

const adapter = resolveMuxAdapter(process.env)
const result = await nudge(adapter, nodeExec, target, 'run the tests')
// result: { taken: true, resubmits: 2 }
```

## `mux.nudge(target, message, opts?, deps?)` / `nudge(adapter, exec, target, message, opts?)`

Types `message` **exactly once**. A swallowed Enter is recovered by flushing the staged buffer (a
bare-Enter `submit`, never a re-type), so a repeated flush can never duplicate the message. Returns
`{ taken, resubmits }`; **throws** if the turn is never taken within the attempt cap.

A pane that no longer exists is rejected up front rather than retried — a gone pane and a booting one
both read back empty, and without the liveness check the retry loop would misreport a dead peer as
"never took the turn".

### `NudgeOptions`

- **`attempts`** — max flush re-submits after the initial send. Default `10`.
- **`settleMs`** — wait after a submit before reading the pane back, in ms. Default `400`.
- **`sleep`** — the delay function, injectable so a test drives the loop with no real wait.

### `NudgeResult`

- **`taken`** — always `true` when `nudge` returns (it throws otherwise).
- **`resubmits`** — how many flushes it took; `0` means the first submit stuck.

## `isStaged(visible, message)`

The predicate underneath, exported for callers building their own verification loop: whether
`message` is still staged in `visible`'s input box (not yet submitted). A real submit scrolls the
message into the transcript, leaving the input box empty; while staged, the message's prefix is still
in the bottom lines. A null/empty `visible` is treated as still-staged, so callers keep retrying
rather than reporting false success.
