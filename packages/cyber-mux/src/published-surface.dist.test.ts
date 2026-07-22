/// <reference types="node" />

import { statSync } from 'node:fs'
// Imported BY PACKAGE NAME, so these resolve through package.json `exports` to the built `dist` —
// exactly what a downstream consumer gets. Testing against `src` would not catch a broken exports
// map, a missing entry, or `dts: true` emitting nothing.
import * as lib from 'cyber-mux'
import * as tpl from 'cyber-mux/template'
import * as wt from 'cyber-mux/worktree'
import { describe, expect, it } from 'vitest'

/**
 * The published-surface guard. This suite runs against the BUILT package (`pnpm test:dist`, after a
 * build), never the source — it is what freezes the library's public shape at the 0.2.0 boundary and
 * proves the whole chain (multi-entry build + exports map + `dts`) actually produced something usable.
 */
describe('spec:cyber-mux/library — published surface', () => {
	describe('built-package smoke: entries import and key values are real', () => {
		it('the . barrel yields the mux core as live values', () => {
			expect(typeof lib.resolveMux).toBe('function')
			expect(typeof lib.probeMultiplexer).toBe('function')
			expect(typeof lib.nudge).toBe('function')
			expect(typeof lib.nodeExec).toBe('function')
			expect(typeof lib.nodeNewId).toBe('function')
			expect(lib.tmuxMuxAdapter.name).toBe('tmux')
			expect(lib.herdrMuxAdapter.name).toBe('herdr')
			expect(lib.weztermMuxAdapter.name).toBe('wezterm')
			expect(lib.zellijMuxAdapter.name).toBe('zellij')
		})

		it('the ./worktree and ./template subpaths yield their seams', () => {
			expect(typeof wt.resolvePrimaryRoot).toBe('function')
			expect(typeof wt.gitWorktreeAdapter.add).toBe('function')
			expect(typeof wt.nodeWorktreeFs.exists).toBe('function')
			expect(typeof wt.worktreeApi).toBe('function')
			expect(typeof tpl.nodeTemplateStore.read).toBe('function')
			expect(typeof tpl.resolveTemplate).toBe('function')
			expect(typeof tpl.templateApi).toBe('function')
		})

		it('emits non-empty .d.mts declarations for every entry (dts: true actually produced types)', () => {
			for (const entry of ['index', 'worktree', 'template', 'cli']) {
				expect(statSync(`dist/${entry}.d.mts`).size).toBeGreaterThan(200)
			}
		})
	})

	describe('surface freeze: the exact exported names of each entry', () => {
		it('. exports the mux core and NOTHING from the CLI-only internals', () => {
			expect(Object.keys(lib).sort()).toEqual([
				'TMUX_TAB_NAME_OPTION',
				'TMUX_WORKSPACE_GROUP_OPTION',
				'callerPane',
				'createWeztermAdapter',
				'createZellijAdapter',
				'currentPane',
				'herdrMuxAdapter',
				'isStaged',
				'nodeExec',
				'nodeNewId',
				'nudge',
				'probeMultiplexer',
				'resolveMux',
				'resolveMuxAdapter',
				'tmuxMuxAdapter',
				'weztermMuxAdapter',
				'withReason',
				'zellijMuxAdapter',
			])
			// The CLI-only surface (console.log / process.exit) must be structurally unreachable from any
			// library entry. Assert the names are absent rather than trusting the list above alone.
			for (const forbidden of [
				'output',
				'printTable',
				'printFields',
				'reportError',
				'CliError',
				'buildProgram',
				'run',
				'tildify',
			]) {
				expect(lib).not.toHaveProperty(forbidden)
				expect(wt).not.toHaveProperty(forbidden)
				expect(tpl).not.toHaveProperty(forbidden)
			}
		})

		it('./worktree exports the git-worktree adapter and its seam', () => {
			expect(Object.keys(wt).sort()).toEqual([
				'WorktreeGitError',
				'assertDistinctFromPrimary',
				'gitWorktreeAdapter',
				'isWorktreeRemovable',
				'listWorktreesFromGit',
				'nodeWorktreeFs',
				'normalizeWorktreePath',
				'provisionWorktree',
				'pruneWorktrees',
				'removeWorktreeSafely',
				'resolvePrimaryRoot',
				'resolveWorktreePath',
				'worktreeApi',
			])
		})

		it('./template exports resolution + the store seam, but NOT the apply engine', () => {
			expect(Object.keys(tpl).sort()).toEqual([
				'assertTemplateName',
				'collectPanes',
				'desugar',
				'firstPane',
				'isValidTemplateName',
				'listTemplates',
				'nodeTemplateStore',
				'parseTemplate',
				'resolveTemplate',
				'resolveTree',
				'templateApi',
				'templateDirs',
				'validateTemplate',
			])
			// The apply engine (openTemplate/applyTemplateToRegion/captureTemplate) is deliberately NOT
			// published — freezing it would lock a much larger, unexercised contract.
			for (const engine of ['openTemplate', 'applyTemplateToRegion', 'captureTemplate']) {
				expect(tpl).not.toHaveProperty(engine)
			}
		})
	})

	describe('probeMultiplexer envPrefix default is CYBER_MUX', () => {
		it('reads $CYBER_MUX by default, and a host prefix when asked', () => {
			const noExec: lib.Exec = () => null
			expect(lib.probeMultiplexer(noExec, { CYBER_MUX: 'tmux', CYBER_MUX_PANE: '%3' })).toEqual({
				mux: 'tmux',
				pane: '%3',
				via: 'env',
			})
			expect(
				lib.probeMultiplexer(noExec, { ACME_MUX: 'herdr', ACME_MUX_PANE: 'p1' }, { envPrefix: 'ACME_MUX' }),
			).toEqual({ mux: 'herdr', pane: 'p1', via: 'env' })
		})
	})

	describe('fake-only integration: drive open/send/read/close through the PUBLISHED adapter', () => {
		it('records the commands a real tmux would receive, touching no real mux/fs/process', () => {
			const commands: string[][] = []
			// A recording fake Exec — the ONLY effect the core touches. No child process is spawned.
			const exec: lib.Exec = (cmd, args) => {
				commands.push([cmd, ...args])
				if (args[0] === 'new-window' || args[0] === 'split-window') return '%7\t@2'
				if (args.includes('capture-pane')) return 'pane output'
				return ''
			}
			// Backend resolved from injected env alone — no ambient detection, no `ps` walk — and the
			// recording `exec` BOUND into the session, so the driving calls carry no exec of their own.
			const mux = lib.resolveMux({ CYBER_MUX: 'tmux' }, { exec })
			expect(mux.name).toBe('tmux')

			const opened = mux.open({ cwd: '/work', at: 'workspace' })
			expect(opened.id).toBe('%7')
			mux.submit(opened, 'echo hello')
			const view = mux.read(opened)
			expect(view).toBe('pane output')
			mux.teardown(opened)

			// The recorded command stream: a window opened, keys submitted, the pane captured and killed —
			// all as argv handed to the injected Exec, never executed.
			const verbs = commands.map((c) => `${c[0]} ${c[1]}`)
			expect(verbs).toContain('tmux new-window')
			expect(verbs.some((v) => v.startsWith('tmux send-keys'))).toBe(true)
			expect(verbs).toContain('tmux capture-pane')
			expect(verbs.some((v) => v.startsWith('tmux kill'))).toBe(true)
		})
	})
})
