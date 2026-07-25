import { describe, expect, it } from 'vitest'
import { AgentLifecycleUnsupportedError, deriveAgentWait } from './agent.ts'
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
})
