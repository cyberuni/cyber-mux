import { describe, expect, it } from 'vitest'
import { collectPanes, resolveTree, type Template } from './template.ts'
import { applyEdits, type EditInput, planEdits, readEditInput, toAnswers } from './template-edit.ts'

const FLAT: Template = {
	name: 'pool-3',
	arrange: 'tiled',
	panes: [{ label: 'w1' }, { label: 'w2', dir: 'apps/web' }, { label: 'w3', command: 'pnpm dev' }],
}

const TREE: Template = {
	name: 'pair',
	root: {
		type: 'split',
		direction: 'right',
		first: { type: 'pane', label: 'planner', command: 'claude' },
		second: { type: 'pane', label: 'runner' },
	},
}

const TABS: Template = {
	name: 'two-tabs',
	tabs: [
		{ label: 'main', panes: [{ label: 'a' }, { label: 'b' }] },
		{ label: 'docs', root: { type: 'pane', label: 'c', dir: 'apps/website' } },
	],
}

const keep: EditInput = { kind: 'keep' }
const set = (value: string): EditInput => ({ kind: 'set', value })

describe('planEdits', () => {
	it('walks a flat template in array order, carrying each pane its context', () => {
		expect(planEdits(FLAT)).toEqual([
			{ index: 0, label: 'w1' },
			{ index: 1, label: 'w2', dir: 'apps/web' },
			{ index: 2, label: 'w3', command: 'pnpm dev' },
		])
	})

	it('walks a tree first-before-second', () => {
		expect(planEdits(TREE)).toEqual([
			{ index: 0, label: 'planner', command: 'claude' },
			{ index: 1, label: 'runner' },
		])
	})

	it('numbers panes WITHIN a tab, and stamps each with its tab', () => {
		// The ordinal restarts per tab because that is how the manifest reports it — a template with two
		// tabs of two panes has two "pane 1"s, told apart by their tab and not by a running count.
		expect(planEdits(TABS)).toEqual([
			{ tab: 0, tabLabel: 'main', index: 0, label: 'a' },
			{ tab: 0, tabLabel: 'main', index: 1, label: 'b' },
			{ tab: 1, tabLabel: 'docs', index: 0, label: 'c', dir: 'apps/website' },
		])
	})

	it('reports the SAME order apply submits in, for both spellings', () => {
		// The load-bearing claim behind the ordinals: a slot's index is the pane's position in the walk
		// `template-session.ts` submits commands in. Asserted against `resolveTree` + `collectPanes`
		// directly, because it is a property of `desugar` this module leans on rather than one it owns —
		// if `tiled` ever stopped laying leaves out in order, this is what would catch it.
		for (const template of [FLAT, TREE]) {
			const applied = collectPanes(resolveTree(template)).map((pane) => pane.label)
			expect(planEdits(template).map((slot) => slot.label)).toEqual(applied)
		}
	})
})

describe('applyEdits', () => {
	it('writes into a flat template without desugaring it', () => {
		// The spelling rule: a flat template comes back flat, with `panes` and `arrange` intact. Desugaring
		// on the way through would rewrite a 5-line template as a nested tree nobody asked for.
		const edited = applyEdits(FLAT, [{ index: 0, field: 'command', value: 'claude' }])
		expect(edited.panes).toEqual([
			{ label: 'w1', command: 'claude' },
			{ label: 'w2', dir: 'apps/web' },
			{ label: 'w3', command: 'pnpm dev' },
		])
		expect(edited.arrange).toBe('tiled')
		expect(edited.root).toBeUndefined()
	})

	it('writes into a tree at the right leaf', () => {
		const edited = applyEdits(TREE, [{ index: 1, field: 'command', value: 'pnpm test' }])
		const root = edited.root as { first: unknown; second: unknown }
		expect(root.first).toEqual({ type: 'pane', label: 'planner', command: 'claude' })
		expect(root.second).toEqual({ type: 'pane', label: 'runner', command: 'pnpm test' })
	})

	it('writes into the addressed tab only', () => {
		const edited = applyEdits(TABS, [{ tab: 1, index: 0, field: 'command', value: 'pnpm docs' }])
		expect(edited.tabs?.[0]?.panes).toEqual([{ label: 'a' }, { label: 'b' }])
		expect(edited.tabs?.[1]?.root).toEqual({ type: 'pane', label: 'c', dir: 'apps/website', command: 'pnpm docs' })
	})

	it('an undefined value DELETES the key rather than storing undefined', () => {
		// `command: undefined` would serialize away anyway, but `dir: undefined` in an object the walk
		// reads with `!== undefined` is a different thing from an absent key. Deleting keeps the two
		// spellings from ever diverging.
		const edited = applyEdits(FLAT, [{ index: 2, field: 'command', value: undefined }])
		expect(edited.panes?.[2]).toEqual({ label: 'w3' })
		expect('command' in (edited.panes?.[2] ?? {})).toBe(false)
	})

	it('never mutates the template it was given', () => {
		const before = structuredClone(FLAT)
		applyEdits(FLAT, [{ index: 0, field: 'command', value: 'claude' }])
		expect(FLAT).toEqual(before)
	})

	it('carries through keys it does not know about', () => {
		// An edit is a field-level change, not a re-serialization. A template carrying a key a newer
		// cyber-mux understands must survive an edit by an older one.
		const exotic = { ...FLAT, futureKey: { deep: true } } as Template & { futureKey: unknown }
		const edited = applyEdits(exotic, [{ index: 0, field: 'label', value: 'renamed' }])
		expect((edited as typeof exotic).futureKey).toEqual({ deep: true })
	})

	it('refuses an answer addressed at a pane or tab that does not exist', () => {
		expect(() => applyEdits(FLAT, [{ index: 9, field: 'command', value: 'x' }])).toThrow('no pane 9')
		expect(() => applyEdits(TABS, [{ tab: 5, index: 0, field: 'command', value: 'x' }])).toThrow('no tab 5')
	})
})

describe('readEditInput', () => {
	it('an empty line KEEPS, because a walk shows every pane and most are passed through', () => {
		expect(readEditInput('')).toEqual(keep)
		expect(readEditInput('   ')).toEqual(keep)
	})

	it('a bare dash clears', () => {
		expect(readEditInput('-')).toEqual(set(''))
		expect(readEditInput('  -  ')).toEqual(set(''))
	})

	it('a quoted dash is a literal dash — the escape hatch out of the clear spelling', () => {
		expect(readEditInput("'-'")).toEqual(set('-'))
		expect(readEditInput('"-"')).toEqual(set('-'))
	})

	it('anything else is the value, trimmed', () => {
		expect(readEditInput('  claude --resume  ')).toEqual(set('claude --resume'))
		// A dash-LEADING command is not the clear spelling and must not be mistaken for it.
		expect(readEditInput('--help')).toEqual(set('--help'))
	})
})

describe('toAnswers', () => {
	it('drops every pane the author kept', () => {
		expect(toAnswers(planEdits(FLAT), [keep, keep, keep], 'command')).toEqual([])
	})

	it('drops an answer equal to what the pane already says', () => {
		// Retyping the current value is a no-op, not a change — so a walk the author typed all the way
		// through still writes nothing if nothing actually differs.
		expect(toAnswers(planEdits(FLAT), [keep, keep, set('pnpm dev')], 'command')).toEqual([])
	})

	it('turns a cleared field into an undefined value', () => {
		expect(toAnswers(planEdits(FLAT), [keep, keep, set('')], 'command')).toEqual([
			{ index: 2, field: 'command', value: undefined },
		])
	})

	it('carries the tab through, and only when there is one', () => {
		expect(toAnswers(planEdits(TABS), [set('a1'), keep, set('c1')], 'command')).toEqual([
			{ tab: 0, index: 0, field: 'command', value: 'a1' },
			{ tab: 1, index: 0, field: 'command', value: 'c1' },
		])
		expect(toAnswers(planEdits(FLAT), [set('x'), keep, keep], 'command')).toEqual([
			{ index: 0, field: 'command', value: 'x' },
		])
	})

	it('a walk cut short leaves the unanswered panes alone', () => {
		// Fewer inputs than slots is what an aborted-then-salvaged walk would look like; the panes with
		// no input must not be read as cleared.
		expect(toAnswers(planEdits(FLAT), [set('claude')], 'command')).toEqual([
			{ index: 0, field: 'command', value: 'claude' },
		])
	})

	it('round-trips through applyEdits into the field it named', () => {
		const slots = planEdits(FLAT)
		const edited = applyEdits(FLAT, toAnswers(slots, [set('claude'), set('pnpm dev'), set('')], 'command'))
		expect(edited.panes).toEqual([
			{ label: 'w1', command: 'claude' },
			{ label: 'w2', dir: 'apps/web', command: 'pnpm dev' },
			{ label: 'w3' },
		])
	})
})
