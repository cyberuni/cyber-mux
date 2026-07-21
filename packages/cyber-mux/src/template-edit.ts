import {
	collectPanes,
	type FlatPane,
	resolveTree,
	type TabNode,
	type Template,
	type TemplateNode,
	type TemplateTree,
} from './template.ts'

/**
 * The edit plan behind `template edit` — what to ask about, and where each answer goes back. PURE,
 * like `template.ts` and `template-capture.ts` and for the same reason: the hard part is addressing a
 * pane inside two different spellings of the same tree, and keeping every seam out means that
 * addressing is testable with plain objects and no terminal at all.
 *
 * **This is why the prompting lives in `cli.ts` and not here.** A guided edit is a conversation, which
 * is inherently stateful and async; the decision of WHAT to ask and WHERE to put the answer is
 * neither. Splitting them at that line keeps the whole interesting half hermetic — every rule below
 * is pinned by a unit test that never opens stdin.
 *
 * **The one rule that shapes everything: a template's SPELLING survives the edit.** A template says
 * its geometry either as an explicit `root` tree or as the flat `panes` + `arrange` sugar, and those
 * are not interchangeable to the human who wrote one. The obvious implementation — desugar, edit the
 * tree, write the tree back — would silently rewrite a hand-written 4-line flat template into a
 * nested `split` tree nobody wants to read. So both `planEdits` and `applyEdits` walk the SOURCE
 * shape and never call `resolveTree`, and a flat template comes back out flat.
 */

/** A field a guided edit can fill. `command` is the reason this verb exists — a capture lands with
 * none (see `template-capture.ts`) — but the addressing is field-agnostic, so adding one later is a
 * new member here and nothing else. */
export type EditField = 'command' | 'label'

/**
 * One pane, as something to ask about: where it lives, and what it says now.
 *
 * `index` is the pane's ordinal in APPLY order — `collectPanes`'s depth-first `first`-before-`second`
 * walk, which is the order the manifest reports and commands submit in (`template-session.ts`'s
 * `ordered`). That is deliberate rather than convenient: the number this prompt shows the author has
 * to be the number they see in the manifest afterwards, or the two views name different panes.
 */
export interface EditSlot {
	/** Which tab, for a `tabs` template; absent for a single-region one. */
	tab?: number
	/** The tab's own label, carried so a prompt can show it without re-walking the template. */
	tabLabel?: string | undefined
	/** Ordinal within this tab, in apply order. */
	index: number
	/**
	 * Where the pane sits on screen, in words — `top-left`, `right`, `center`.
	 *
	 * The one thing that actually answers "which pane am I being asked about?", which an ordinal and a
	 * label cannot: apply order is a tree walk, not a reading order, so pane 2 of a 2x2 is the pane
	 * BELOW pane 1 rather than the one beside it. Absent when the tab holds one pane (there is nothing
	 * to tell apart) or when the geometry cannot be resolved.
	 */
	position?: string
	label?: string
	dir?: string
	command?: string
}

/** A pane's share of its tab, as fractions of the whole — the unit square, never cells. */
export interface UnitRect {
	x: number
	y: number
	width: number
	height: number
}

/**
 * One answer, addressed back to the slot it came from.
 *
 * `value: undefined` CLEARS the field rather than meaning "no answer" — a slot the author left alone
 * yields no `EditAnswer` at all. Keeping "unset it" and "did not say" as different things is what
 * lets `applyEdits` be a total function of its answers: it never has to guess whether an absent
 * value meant erase or skip.
 */
export interface EditAnswer {
	tab?: number
	index: number
	field: EditField
	value: string | undefined
}

/**
 * A tree's panes in apply order, as references INTO the template.
 *
 * The two spellings converge here and nowhere else. For the flat sugar the panes are already a list
 * in the order `desugar` lays them out — both `comb` and `tiled` slice contiguously and preserve
 * order, so the array index IS the apply ordinal (pinned by a test, since that is a property of
 * `desugar` this module depends on rather than one it owns). For the explicit tree it is
 * `collectPanes` on `root`, which is the very walk apply uses.
 *
 * Returning references is the whole trick: `applyEdits` clones the template first, then mutates
 * what this hands back, so a write lands in the clone's own `panes[]` or `root` subtree without this
 * module ever knowing which spelling it was.
 */
function treePanes(tree: TemplateTree): FlatPane[] {
	if (tree.root) return collectPanes(tree.root)
	return tree.panes ?? []
}

/**
 * Where every pane in a tree lands, as fractions of the tab — the geometry a template DETERMINES,
 * computed the same way apply builds it.
 *
 * `ratio` is the fraction kept by `first` (the original pane), so a `right` split at 0.6 puts `first`
 * in the left 60% and `second` in what is left. Splitting the remainder rather than multiplying by
 * `1 - ratio` is what keeps a comb exact: three even panes come out at exactly 1/3 each instead of
 * drifting on the last one.
 *
 * Unit fractions rather than cells because a template has no size — it is applied to whatever region
 * it is given, and the only honest thing to say is a proportion.
 */
function layout(node: TemplateNode, rect: UnitRect, acc: UnitRect[] = []): UnitRect[] {
	if (node.type === 'pane') {
		acc.push(rect)
		return acc
	}
	const ratio = node.ratio ?? 0.5
	if (node.direction === 'right') {
		const width = rect.width * ratio
		layout(node.first, { ...rect, width }, acc)
		layout(node.second, { ...rect, x: rect.x + width, width: rect.width - width }, acc)
	} else {
		const height = rect.height * ratio
		layout(node.first, { ...rect, height }, acc)
		layout(node.second, { ...rect, y: rect.y + height, height: rect.height - height }, acc)
	}
	return acc
}

/**
 * A rect in words, from where its CENTER falls on a 3x3 grid.
 *
 * Thirds rather than halves because halves cannot name a middle: a row of three panes would come out
 * `left`, `left`, `right`, which is worse than saying nothing. Reading the center rather than the
 * edges is what makes an uneven split still land in the band a human would point at — a pane taking
 * the left 60% is `left`, not straddling.
 *
 * Deliberately coarse. This is a hint that tells two panes apart on one screen, not a coordinate; a
 * template with a dozen panes will repeat a word, and the ordinal is still what identifies a pane.
 */
export function describePosition(rect: UnitRect): string {
	const column = band(rect.x + rect.width / 2, 'left', 'center', 'right')
	const row = band(rect.y + rect.height / 2, 'top', 'middle', 'bottom')
	if (row === 'middle') return column === 'center' ? 'center' : column
	if (column === 'center') return row
	return `${row}-${column}`
}

function band(center: number, low: string, mid: string, high: string): string {
	if (center < 1 / 3) return low
	if (center > 2 / 3) return high
	return mid
}

/**
 * Each pane's position, in apply order — or nothing at all.
 *
 * Empty for a single-pane tree, because "center" said of the only pane is noise rather than a
 * bearing. Empty too when the tree cannot be resolved: this is a display hint, and a template
 * malformed enough to defeat `resolveTree` should still be walkable rather than refused HERE, where
 * the error would name the wrong thing. Validation is the caller's job and already ran.
 */
function positionsOf(tree: Template | TabNode): string[] {
	let rects: UnitRect[]
	try {
		rects = layout(resolveTree(tree), { x: 0, y: 0, width: 1, height: 1 })
	} catch {
		return []
	}
	return rects.length < 2 ? [] : rects.map(describePosition)
}

/**
 * Every pane worth asking about, in the order a walk should ask.
 *
 * Tabs in order, panes within each tab in apply order — the same traversal `walkTabs` submits
 * commands in, so an author filling this top to bottom is filling it in the order it will run.
 */
export function planEdits(template: Template): EditSlot[] {
	const slots: EditSlot[] = []
	if (template.tabs) {
		template.tabs.forEach((tab, index) => {
			const positions = positionsOf(tab)
			for (const [ordinal, pane] of treePanes(tab).entries()) {
				slots.push({ tab: index, tabLabel: tab.label, index: ordinal, ...at(positions, ordinal), ...fields(pane) })
			}
		})
		return slots
	}
	const positions = positionsOf(template)
	for (const [ordinal, pane] of treePanes(template).entries()) {
		slots.push({ index: ordinal, ...at(positions, ordinal), ...fields(pane) })
	}
	return slots
}

/** A position when there is one — absent rather than an empty string, like every other slot field. */
function at(positions: string[], ordinal: number): { position?: string } {
	const position = positions[ordinal]
	return position ? { position } : {}
}

/** What a slot reports about a pane — the fields a prompt shows, never the pane object itself. */
function fields(pane: FlatPane): Pick<EditSlot, 'label' | 'dir' | 'command'> {
	const out: Pick<EditSlot, 'label' | 'dir' | 'command'> = {}
	if (pane.label !== undefined) out.label = pane.label
	if (pane.dir !== undefined) out.dir = pane.dir
	if (pane.command !== undefined) out.command = pane.command
	return out
}

/**
 * The template with every answer written in — a NEW template, never the one passed in.
 *
 * Cloning rather than mutating is what makes `--dry-run` free and a failed validation harmless: the
 * caller still holds the original, so a refusal to write costs nothing and there is no half-edited
 * template to roll back. It also means an answer addressed at a pane that does not exist is caught
 * before anything is written, which is the only way this can fail.
 *
 * Everything not addressed is carried through verbatim, including keys this schema does not know
 * about — `structuredClone` copies the parsed JSON, so an edit is genuinely a field-level change and
 * never a re-serialization that quietly drops what it did not understand.
 */
export function applyEdits(template: Template, answers: EditAnswer[]): Template {
	const next = structuredClone(template)
	for (const answer of answers) {
		const tree: TemplateTree | undefined = answer.tab === undefined ? next : next.tabs?.[answer.tab]
		if (!tree) throw new Error(`this template has no tab ${answer.tab}`)
		const pane = treePanes(tree)[answer.index]
		if (!pane) {
			const where = answer.tab === undefined ? 'this template' : `tab ${answer.tab}`
			throw new Error(`${where} has no pane ${answer.index}`)
		}
		if (answer.value === undefined) delete pane[answer.field]
		else pane[answer.field] = answer.value
	}
	return next
}

/**
 * The token that ADDRESSES a pane on the command line — `3`, or `2.3` in a tabs template. Both
 * 1-based, because they are read and typed by humans and agents rather than indexed by code.
 *
 * This is what the listing prints in its `pane` column and what `--set` takes, deliberately the same
 * string: an agent's loop is list-then-act, and a listing whose identifiers cannot be pasted straight
 * into the next command forces it to derive them. Panes are addressed by ORDINAL and never by label,
 * because a label is explicitly a name two panes may share (`PaneNode.label`) — an ambiguous selector
 * in a non-interactive API is a silent wrong-pane write.
 */
export function slotRef(slot: EditSlot): string {
	return slot.tab === undefined ? `${slot.index + 1}` : `${slot.tab + 1}.${slot.index + 1}`
}

/** One `--set <ref>=<value>`, parsed. `value: undefined` clears, exactly as `-` does interactively. */
export interface SetSpec {
	ref: string
	value: string | undefined
}

/**
 * Parse a `--set` argument into a reference and a value.
 *
 * Split on the FIRST `=` only, so a command containing one (`--set 1=FOO=bar make`) keeps it. An
 * empty value clears the field — the flag spelling of the walk's `-`, and unambiguous here because a
 * shell already distinguishes `--set 1=` from omitting the flag.
 */
export function parseSet(spec: string): SetSpec {
	const at = spec.indexOf('=')
	if (at === -1) throw new Error(`--set needs <pane>=<value>, got "${spec}"`)
	const ref = spec.slice(0, at).trim()
	if (ref === '') throw new Error(`--set needs a pane before the "=", got "${spec}"`)
	const value = spec.slice(at + 1)
	return { ref, value: value === '' ? undefined : value }
}

/**
 * Turn `--set` specs into answers against a known set of slots.
 *
 * Every reference is resolved BEFORE any answer is produced, so a batch naming one bad pane writes
 * none of them — a partial application of a multi-pane edit is the worst outcome available here,
 * since the caller cannot tell which half landed without re-reading the file.
 *
 * A value equal to what the pane already says yields no answer at all, which is what makes a re-run
 * of the same `--set` a no-op rather than a rewrite (AXI's idempotent-mutation rule).
 */
export function resolveSets(slots: EditSlot[], specs: SetSpec[], field: EditField): EditAnswer[] {
	const byRef = new Map(slots.map((slot) => [slotRef(slot), slot]))
	const answers: EditAnswer[] = []
	for (const spec of specs) {
		const slot = byRef.get(spec.ref)
		if (!slot) {
			throw new Error(
				`no pane "${spec.ref}" in this template — it has ${slots.length} ` +
					`${slots.length === 1 ? 'pane' : 'panes'}: ${[...byRef.keys()].join(', ')}`,
			)
		}
		if (spec.value === slot[field]) continue
		const answer: EditAnswer = { index: slot.index, field, value: spec.value }
		if (slot.tab !== undefined) answer.tab = slot.tab
		answers.push(answer)
	}
	return answers
}

/**
 * How a typed line becomes an answer — the prompt's one piece of vocabulary, here rather than in
 * `cli.ts` so it is pinned by a unit test alongside the rules it serves.
 *
 * Three cases, and the empty one is the important one: a guided walk shows every pane, so the author
 * passes through panes they do not want to touch far more often than ones they do. Enter therefore
 * has to mean KEEP, which leaves "erase this" needing a spelling of its own — `-`, because it is one
 * keystroke and is not a plausible command. A literal `-` is reachable by quoting it.
 */
export type EditInput = { kind: 'keep' } | { kind: 'set'; value: string }

export function readEditInput(line: string): EditInput {
	const trimmed = line.trim()
	if (trimmed === '') return { kind: 'keep' }
	if (trimmed === '-') return { kind: 'set', value: '' }
	if (trimmed === "'-'" || trimmed === '"-"') return { kind: 'set', value: '-' }
	return { kind: 'set', value: trimmed }
}

/**
 * The answers a walk produces, given what each slot was told — the pure core of the conversation.
 *
 * A `set` to the empty string is what CLEARS the field, which is why `readEditInput` maps `-` to it:
 * the schema has no use for `command: ""` (apply skips a falsy command anyway, see `submitCommands`),
 * so storing one would be storing a lie about a pane that runs nothing. An answer equal to what the
 * pane already says is dropped entirely, so a walk where the author pressed Enter through everything
 * reports zero changes rather than N no-op writes.
 */
export function toAnswers(slots: EditSlot[], inputs: EditInput[], field: EditField): EditAnswer[] {
	const answers: EditAnswer[] = []
	for (const [index, slot] of slots.entries()) {
		const input = inputs[index]
		if (!input || input.kind === 'keep') continue
		const value = input.value === '' ? undefined : input.value
		if (value === slot[field]) continue
		const answer: EditAnswer = { index: slot.index, field, value }
		if (slot.tab !== undefined) answer.tab = slot.tab
		answers.push(answer)
	}
	return answers
}
