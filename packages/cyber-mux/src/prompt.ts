import { createInterface } from 'node:readline/promises'

/**
 * The interactive seam — a line asked of a human, injected for exactly the reason `Exec` and
 * `TemplateStore` are: `template edit` is a conversation, and a conversation reaching for
 * `process.stdin` directly would make it the one verb `cli.test.ts` cannot drive.
 *
 * **This is the package's first async seam, and deliberately its narrowest.** `Exec` is synchronous
 * by construction and every adapter is built on that; nothing here changes it. A prompt cannot be
 * synchronous, so it gets its own seam rather than widening that one — no adapter, no backend and no
 * pure module ever sees this type, and the async reaches exactly one command's action.
 */
export interface Prompt {
	/**
	 * Ask one question and resolve to the line typed.
	 *
	 * `undefined` means the human is GONE — EOF, a closed stream, Ctrl-D — and is a distinct answer
	 * from `''` (they pressed Enter). The caller must stop asking on `undefined`; continuing would
	 * spin through every remaining question against a dead stream.
	 *
	 * `initial` is pre-filled into the editable line, so answering "the same but one flag different"
	 * is an edit rather than a retype. Best-effort: a stream that cannot pre-fill still asks.
	 */
	ask(question: string, initial?: string): Promise<string | undefined>
	/** Release the terminal. Safe to call twice; the caller does so in a `finally`. */
	close(): void
}

/**
 * Opening a prompt is a FACTORY rather than a live `Prompt` on `Deps`, and that is load-bearing: a
 * readline interface holds stdin open from the moment it exists, so building one at program-assembly
 * time would make every unrelated verb — `list`, `doctor`, `send` — hang instead of exiting. Only the
 * command that actually converses calls this.
 */
export type OpenPrompt = () => Prompt

export const realPrompt: OpenPrompt = () => {
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	// Latched rather than checked per-question: once the stream is gone it stays gone, and a flag read
	// before each `question` is what keeps a walk from issuing N doomed reads after the first EOF.
	let closed = false
	rl.on('close', () => {
		closed = true
	})
	return {
		async ask(question, initial) {
			if (closed) return undefined
			// Raced against `close` because readline's own question promise never settles on Ctrl-D — it
			// emits `close` and leaves the caller awaiting forever. Whichever lands first wins, so an EOF
			// mid-question surfaces as `undefined` rather than a hung CLI.
			return await new Promise<string | undefined>((resolve) => {
				let settled = false
				const settle = (value: string | undefined) => {
					if (settled) return
					settled = true
					rl.off('close', onClose)
					resolve(value)
				}
				const onClose = () => settle(undefined)
				rl.once('close', onClose)
				rl.question(question).then(settle, () => settle(undefined))
				// AFTER `question`, which is what puts the text in the editable line rather than printing it.
				if (initial) rl.write(initial)
			})
		},
		close: () => rl.close(),
	}
}
