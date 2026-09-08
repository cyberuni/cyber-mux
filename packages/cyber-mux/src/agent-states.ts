import type { AgentStatus } from './mux.ts'

/**
 * The agent-wait STATE-SET refusal — what an `AgentLifecycle` backend answers when it has the native
 * wait but cannot express the state set the caller asked for.
 *
 * Its own module rather than a member of `agent.ts` for the reason `floating.ts`/`zoom.ts`/`resize.ts`
 * are their own modules: the adapters throw it, and `agent.ts` imports `backend.ts`, which imports
 * every adapter — so an adapter reaching into `agent.ts` for the class would close a cycle. The class
 * lives here and RIDES OUT on the `cyber-mux/agent` subpath (re-exported by `agent.ts`), because the
 * capability it belongs to is that subpath's and deliberately not on the core barrel.
 */

/**
 * A wait asked for states the backend's native wait cannot name. Distinct from
 * `AgentLifecycleUnsupportedError`, and the distinction is the whole point: that one says *this
 * backend has no agent wait at all*; this one says *it has one, and its vocabulary is narrower than
 * what you asked for*. Collapsing them would tell a caller on otty to "run it on herdr" when the fix
 * is to drop one state from `until`.
 *
 * **Refused by NAME rather than silently narrowed**, which is the only honest answer available. A
 * backend that waits on `idle` alone, handed `until: ['idle', 'blocked']`, has exactly three options:
 * wait for `idle` only and return it (a wait that ends on a state the caller did not ask for — the
 * plausible-wrong-answer shape), wait for all of them (impossible, there is no flag), or say so. It
 * says so.
 *
 * PORTABLE and exit-code-free by design, the same shape every other seam refusal takes. `backend`
 * names the backend, `requested` the set that was asked for, and `supported` the set the backend can
 * actually end a wait on — so a caller composes the fix without re-deriving any of it.
 */
export class AgentWaitStatesUnsupportedError extends Error {
	constructor(
		readonly backend: string,
		readonly requested: readonly AgentStatus[],
		readonly supported: readonly AgentStatus[],
	) {
		super(`${backend} can only end an agent wait on ${supported.join(', ')} — asked for ${requested.join(', ')}`)
		this.name = 'AgentWaitStatesUnsupportedError'
	}
}

/**
 * Refuse an `until` set a backend's native wait cannot express — the single spelling of the refusal,
 * so a second backend with a narrow vocabulary cannot drift into a second message.
 *
 * Takes the backend NAME rather than the adapter, for `refuseFloatingPane`/`refusePaneZoom`'s reason:
 * it is called from inside an adapter method while the adapter object is still being constructed, and
 * the name is the only thing the error carries anyway.
 */
export function refuseAgentWaitStates(
	backend: string,
	requested: readonly AgentStatus[],
	supported: readonly AgentStatus[],
): never {
	throw new AgentWaitStatesUnsupportedError(backend, requested, supported)
}

/**
 * Whether `until` is satisfiable by a backend whose native wait ends on exactly `supported`.
 *
 * An EMPTY or omitted `until` is satisfiable by construction: the seam defines it as *take the
 * backend's own default*, and a backend never restates that default in the command it runs — so there
 * is nothing to check. A non-empty set is satisfiable only when every state in it is one the backend
 * can end on; a set that names a state the backend cannot reach would otherwise end the wait on a
 * state nobody asked for.
 */
export function agentWaitStatesSatisfiable(
	until: readonly AgentStatus[] | undefined,
	supported: readonly AgentStatus[],
): boolean {
	if (!until || until.length === 0) return true
	return until.every((state) => supported.includes(state))
}
