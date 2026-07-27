import { describe, expect, it } from 'vitest'
import { AgentLifecycleUnsupportedError, agentApi, deriveAgentWait } from './agent.ts'
import type { Exec } from './exec.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'
import type { MuxAdapter } from './mux.ts'
import { weztermMuxAdapter } from './mux.wezterm.ts'
import { zellijMuxAdapter } from './mux.zellij.ts'

describe('spec:cyber-mux/agent', () => {
	// An exec that throws the moment it is touched — proves the refusal happens BEFORE any exec, so
	// nothing is produced. Mirrors template-capture.test.ts's explodingExec exactly.
	const explodingExec = (() => {
		throw new Error('deriveAgentWait must refuse before running any command')
	}) as unknown as Exec

	it('agent-wait-unsupported-refused', () => {
		// The outline's three rows — tmux, wezterm, zellij — driven against the real adapters, none of
		// which carries the agentLifecycle capability. deriveAgentWait refuses each, naming that backend,
		// before ever reaching the exec.
		for (const adapter of [tmuxMuxAdapter, weztermMuxAdapter, zellijMuxAdapter] as MuxAdapter[]) {
			expect(() => deriveAgentWait(adapter, explodingExec, { id: 'p1' }, {})).toThrow(AgentLifecycleUnsupportedError)
			try {
				deriveAgentWait(adapter, explodingExec, { id: 'p1' }, {})
			} catch (err) {
				expect(err).toBeInstanceOf(AgentLifecycleUnsupportedError)
				expect((err as AgentLifecycleUnsupportedError).backend).toBe(adapter.name)
			}
		}
	})

	// ── The agentApi facade (cyber-mux/agent subpath) ──
	// Each backend is picked by the $CYBER_MUX fast-path (no `ps` walk, so the exec is never touched
	// during resolution), and a fake exec answers just the one command the method under test runs —
	// `herdr pane list`, `herdr agent wait`, or the no-feed backend's own listing. Every id below
	// matches what that backend's real `listPanes` would report from the faked output.

	// A recording exec that answers each backend's own listing verb with a single live pane carrying
	// `id`, plus (for herdr) the `agent wait` envelope reporting `reached`. Anything else returns null.
	const fakeExec = (opts: {
		id: string
		agentStatus?: string
		reached?: string
	}): { exec: Exec; calls: string[][] } => {
		const calls: string[][] = []
		const exec: Exec = (cmd, args) => {
			calls.push([cmd, ...args])
			if (cmd === 'herdr' && args[0] === 'pane' && args[1] === 'list') {
				const pane: Record<string, unknown> = { pane_id: opts.id }
				if (opts.agentStatus !== undefined) pane['agent_status'] = opts.agentStatus
				return JSON.stringify({ result: { panes: [pane] } })
			}
			if (cmd === 'herdr' && args[0] === 'agent' && args[1] === 'wait') {
				return JSON.stringify({ result: { agent: { agent_status: opts.reached } } })
			}
			// tmux `list-panes -F` — five tab fields (id, cmd, cwd, title, host); empty title/host so no label.
			if (cmd === 'tmux' && args[0] === 'list-panes') return `${opts.id}\t\t\t\t`
			// wezterm `cli list --format json`.
			if (cmd === 'wezterm' && args[0] === 'cli' && args[1] === 'list')
				return JSON.stringify([{ pane_id: opts.id, tab_id: 0, window_id: 0 }])
			// zellij `action list-panes --json`.
			if (cmd === 'zellij' && args[0] === 'action' && args[1] === 'list-panes')
				return JSON.stringify([{ id: opts.id, tab_id: 0 }])
			return null
		}
		return { exec, calls }
	}

	it('agent-api-supported-reflects-backend', () => {
		// herdr carries the agentLifecycle capability; tmux/wezterm/zellij do not. supported() reads that
		// presence directly and never touches the exec, so an exploding runner proves it stays untouched.
		expect(agentApi({ CYBER_MUX: 'herdr' }, { exec: explodingExec }).supported()).toBe(true)
		for (const backend of ['tmux', 'wezterm', 'zellij']) {
			expect(agentApi({ CYBER_MUX: backend }, { exec: explodingExec }).supported()).toBe(false)
		}
	})

	it('agent-api-status-reads-snapshot', () => {
		// herdr's per-pane agent-state feed reports `working`; status reads that snapshot for the one pane.
		const { exec } = fakeExec({ id: 'p1', agentStatus: 'working' })
		expect(agentApi({ CYBER_MUX: 'herdr' }, { exec }).status({ id: 'p1' })).toBe('working')
	})

	it('agent-api-status-undefined-no-feed', () => {
		// A live pane on a backend with no agent-state feed: the pane is present, yet agentStatus is
		// absent-not-false, so status is undefined — exactly as LivePane.agentStatus omits the field there.
		for (const backend of ['tmux', 'wezterm', 'zellij']) {
			const { exec } = fakeExec({ id: 'p1' })
			expect(agentApi({ CYBER_MUX: backend }, { exec }).status({ id: 'p1' })).toBeUndefined()
		}
	})

	it('agent-api-wait-drives-herdr', () => {
		// herdr's wait drives `herdr agent wait` and returns the reached status the envelope reports.
		const { exec, calls } = fakeExec({ id: 'p1', reached: 'idle' })
		const reached = agentApi({ CYBER_MUX: 'herdr' }, { exec }).wait({ id: 'p1' }, { until: ['idle'] })
		expect(reached).toBe('idle')
		expect(calls.some((c) => c[0] === 'herdr' && c[1] === 'agent' && c[2] === 'wait')).toBe(true)
	})

	it('agent-api-wait-routes-through-refusal', () => {
		// The facade's wait routes through deriveAgentWait, so on a backend without the capability it
		// refuses before any exec — identical to calling deriveAgentWait directly, no second refusal path.
		for (const backend of ['tmux', 'wezterm', 'zellij']) {
			const api = agentApi({ CYBER_MUX: backend }, { exec: explodingExec })
			expect(() => api.wait({ id: 'p1' })).toThrow(AgentLifecycleUnsupportedError)
			try {
				api.wait({ id: 'p1' })
			} catch (err) {
				expect((err as AgentLifecycleUnsupportedError).backend).toBe(backend)
			}
		}
	})
})
