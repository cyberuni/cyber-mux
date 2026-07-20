import { collectPanes, type FlatPane, type Template, type TemplateTree } from './template.ts'

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
	tabLabel?: string
	/** Ordinal within this tab, in apply order. */
	index: number
	label?: string
	dir?: string
	command?: string
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
 * Every pane worth asking about, in the order a walk should ask.
 *
 * Tabs in order, panes within each tab in apply order — the same traversal `walkTabs` submits
 * commands in, so an author filling this top to bottom is filling it in the order it will run.
 */
export function planEdits(template: Template): EditSlot[] {
	const slots: EditSlot[] = []
	if (template.tabs) {
		template.tabs.forEach((tab, index) => {
			for (const [ordinal, pane] of treePanes(tab).entries()) {
				slots.push({ tab: index, tabLabel: tab.label, index: ordinal, ...fields(pane) })
			}
		})
		return slots
	}
	for (const [ordinal, pane] of treePanes(template).entries()) slots.push({ index: ordinal, ...fields(pane) })
	return slots
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
