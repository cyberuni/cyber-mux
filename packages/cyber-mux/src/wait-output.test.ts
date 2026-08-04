import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import type { MuxAdapter, MuxReadOptions, MuxTarget } from './mux.ts'
import { assertWaitPattern, DEFAULT_WAIT_POLL_MS, matchWaitPattern, pollForOutput } from './wait-output.ts'

const exec: Exec = () => null
const TARGET: MuxTarget = { id: 'p-1' }

/**
 * A recording adapter for the poll loop: `reads` is consumed one snapshot per poll (the last one
 * repeating forever, so a test names only the snapshots that differ), and `alive` answers the liveness
 * probe as a function of how many reads have happened — which is how "the pane died mid-wait" is
 * expressed without a real multiplexer.
 *
 * Every other member throws: the poll loop is specified to touch `read` and `paneExists` and nothing
 * else, and a throw is the only assertion that holds even when a future edit adds a call.
 */
function fakeAdapter(opts: { reads: string[]; alive?: (readCount: number) => boolean }) {
	const readOpts: (MuxReadOptions | undefined)[] = []
	let readCount = 0
	let existsCount = 0
	const unused = () => {
		throw new Error('the wait polls read/paneExists only')
	}
	const adapter: MuxAdapter = {
		name: 'fake',
		open: unused,
		rename: unused,
		group: unused,
		sendText: unused,
		sendKeys: unused,
		submit: unused,
		read: (_exec, _target, o) => {
			readOpts.push(o)
			const value = opts.reads[Math.min(readCount, opts.reads.length - 1)] ?? ''
			readCount++
			return { text: value }
		},
		waitForOutput: unused,
		focus: unused,
		teardown: unused,
		paneExists: () => {
			existsCount++
			return opts.alive ? opts.alive(readCount) : true
		},
		isPaneFocused: unused,
		listPanes: unused,
	}
	return {
		adapter,
		readOpts,
		reads: () => readCount,
		existsChecks: () => existsCount,
	}
}

/** A clock and a sleep that move TOGETHER: sleeping is the only thing that advances time, so a test's
 * timeout is reached after a known number of polls rather than after a real wall-clock wait. */
function fakeClock() {
	let ms = 0
	const slept: number[] = []
	return {
		now: () => ms,
		sleep: async (wait: number) => {
			slept.push(wait)
			ms += wait
		},
		slept,
	}
}

describe('assertWaitPattern', () => {
	it('accepts exactly one of match/regex', () => {
		expect(() => assertWaitPattern({ match: 'ready', timeoutMs: 10 })).not.toThrow()
		expect(() => assertWaitPattern({ regex: 'rea+dy', timeoutMs: 10 })).not.toThrow()
	})

	it('refuses both patterns at once rather than picking a winner', () => {
		expect(() => assertWaitPattern({ match: 'ready', regex: 'ready', timeoutMs: 10 })).toThrow(/got both/)
	})

	it('refuses neither — there is nothing to wait for', () => {
		expect(() => assertWaitPattern({ timeoutMs: 10 })).toThrow(/got neither/)
	})

	it('refuses an empty literal, which would match every snapshot instantly', () => {
		expect(() => assertWaitPattern({ match: '', timeoutMs: 10 })).toThrow(/must not be empty/)
	})

	it('refuses a malformed regex up front, on every backend alike', () => {
		expect(() => assertWaitPattern({ regex: 'ready(', timeoutMs: 10 })).toThrow(/not a valid expression/)
	})
})

describe('matchWaitPattern', () => {
	it('matches a literal substring anywhere in the snapshot', () => {
		const result = matchWaitPattern('booting\nserver ready on :8080\n', { match: 'ready', timeoutMs: 10 })
		expect(result.matched).toBe(true)
		expect(result.matchedLine).toBe('server ready on :8080')
	})

	it('matches a regex, and points at the one line carrying it', () => {
		const result = matchWaitPattern('booting\nlistening on 8080\n', { regex: 'on \\d+', timeoutMs: 10 })
		expect(result).toEqual({ matched: true, output: 'booting\nlistening on 8080\n', matchedLine: 'listening on 8080' })
	})

	it('reports no match with the snapshot it searched, so the caller keeps the evidence', () => {
		const result = matchWaitPattern('booting\n', { match: 'ready', timeoutMs: 10 })
		expect(result).toEqual({ matched: false, output: 'booting\n' })
	})

	it('omits matchedLine when the match spans lines — there is no single line to point at', () => {
		const result = matchWaitPattern('done\nready\n', { regex: 'done\\sready', timeoutMs: 10 })
		expect(result.matched).toBe(true)
		expect(result.matchedLine).toBeUndefined()
	})
})

describe('pollForOutput', () => {
	it('searches what is already on screen before sleeping at all', async () => {
		const fake = fakeAdapter({ reads: ['server ready'] })
		const clock = fakeClock()
		const result = await pollForOutput(fake.adapter, exec, TARGET, {
			match: 'ready',
			timeoutMs: 5_000,
			now: clock.now,
			sleep: clock.sleep,
		})
		expect(result.matched).toBe(true)
		expect(fake.reads()).toBe(1)
		// The whole claim: a pattern already printed costs no wait at all.
		expect(clock.slept).toEqual([])
	})

	it('polls until the pattern appears, at the default cadence', async () => {
		const fake = fakeAdapter({ reads: ['booting', 'booting', 'server ready on :8080'] })
		const clock = fakeClock()
		const result = await pollForOutput(fake.adapter, exec, TARGET, {
			match: 'ready',
			timeoutMs: 5_000,
			now: clock.now,
			sleep: clock.sleep,
		})
		expect(result).toEqual({ matched: true, output: 'server ready on :8080', matchedLine: 'server ready on :8080' })
		expect(clock.slept).toEqual([DEFAULT_WAIT_POLL_MS, DEFAULT_WAIT_POLL_MS])
	})

	it('honors an explicit poll cadence', async () => {
		const fake = fakeAdapter({ reads: ['booting', 'ready'] })
		const clock = fakeClock()
		await pollForOutput(fake.adapter, exec, TARGET, {
			match: 'ready',
			timeoutMs: 5_000,
			pollMs: 25,
			now: clock.now,
			sleep: clock.sleep,
		})
		expect(clock.slept).toEqual([25])
	})

	it('reports the timeout as an answer, carrying the last snapshot it searched', async () => {
		const fake = fakeAdapter({ reads: ['booting'] })
		const clock = fakeClock()
		const result = await pollForOutput(fake.adapter, exec, TARGET, {
			match: 'ready',
			timeoutMs: 300,
			pollMs: 100,
			now: clock.now,
			sleep: clock.sleep,
		})
		expect(result).toEqual({ matched: false, output: 'booting' })
		// Reads at 0, 100, 200 and 300ms: the deadline is checked AFTER a read, so the last look happens
		// at the deadline rather than one poll short of it.
		expect(fake.reads()).toBe(4)
	})

	it('still looks once when the timeout is zero', async () => {
		const fake = fakeAdapter({ reads: ['server ready'] })
		const clock = fakeClock()
		const result = await pollForOutput(fake.adapter, exec, TARGET, {
			match: 'ready',
			timeoutMs: 0,
			now: clock.now,
			sleep: clock.sleep,
		})
		expect(result.matched).toBe(true)
		expect(fake.reads()).toBe(1)
	})

	it('scopes the searched snapshot to `lines`, through the adapter’s own read', async () => {
		const fake = fakeAdapter({ reads: ['ready'] })
		await pollForOutput(fake.adapter, exec, TARGET, { match: 'ready', timeoutMs: 10, lines: 5 })
		expect(fake.readOpts).toEqual([{ lines: 5 }])
	})

	it('refuses a pane that is already gone, before waiting out the timeout', async () => {
		const fake = fakeAdapter({ reads: ['booting'], alive: () => false })
		await expect(pollForOutput(fake.adapter, exec, TARGET, { match: 'ready', timeoutMs: 60_000 })).rejects.toThrow(
			/no longer exists/,
		)
		// Nothing was read and nothing was slept — the probe runs first, so a dead pane fails at once.
		expect(fake.reads()).toBe(0)
	})

	it('throws rather than reporting a pane that died mid-wait as a quiet one', async () => {
		// Alive for the first two reads, gone after — the deadline then finds a dead pane, which is a
		// failure, not a timeout.
		const fake = fakeAdapter({ reads: ['booting'], alive: (readCount) => readCount < 2 })
		const clock = fakeClock()
		await expect(
			pollForOutput(fake.adapter, exec, TARGET, {
				match: 'ready',
				timeoutMs: 100,
				pollMs: 100,
				now: clock.now,
				sleep: clock.sleep,
			}),
		).rejects.toThrow(/no longer exists/)
	})

	it('probes liveness only at the ends, never once per poll', async () => {
		const fake = fakeAdapter({ reads: ['booting'] })
		const clock = fakeClock()
		await pollForOutput(fake.adapter, exec, TARGET, {
			match: 'ready',
			timeoutMs: 500,
			pollMs: 100,
			now: clock.now,
			sleep: clock.sleep,
		})
		expect(fake.reads()).toBe(6)
		expect(fake.existsChecks()).toBe(2)
	})

	it('rejects an unusable pattern before touching the backend', async () => {
		const fake = fakeAdapter({ reads: ['booting'] })
		await expect(pollForOutput(fake.adapter, exec, TARGET, { timeoutMs: 10 })).rejects.toThrow(/got neither/)
		expect(fake.existsChecks()).toBe(0)
	})
})
