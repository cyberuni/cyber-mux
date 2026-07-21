import { randomUUID } from 'node:crypto'

/**
 * The id-minting seam: a source of fresh, collision-free opaque ids. Injected for the same reason
 * `Exec` and `TemplateStore` are — a backend or a walk that mints an id reaches for THIS rather than
 * `node:crypto` directly, so it stays a pure function of its inputs and a test can drive it with a
 * deterministic counter instead of a real UUID.
 *
 * The value is opaque: callers that want a short form slice it themselves. The only contract is that
 * two calls never collide within a run.
 */
export type NewId = () => string

/** The real id source — a v4 UUID. The shell binds this; core takes `NewId` as a parameter. */
export const nodeNewId: NewId = () => randomUUID()
