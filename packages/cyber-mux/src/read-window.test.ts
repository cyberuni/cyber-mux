import { describe, expect, it } from 'vitest'
import { capturedRows, isReadTruncated } from './read-window.ts'

describe('spec:cyber-mux/mux/driving', () => {
	// The pure half of the truncation answer — one rule the four adapters share, testable with no
	// multiplexer at all. Each adapter owns only how its backend spells "one row deeper".
	describe('capturedRows', () => {
		it('counts terminal rows, treating a trailing newline as a terminator rather than a row', () => {
			// `capture-pane` and `dump-screen` both end with a newline; counting it would make every capture
			// look one row longer than the screen — and would compare unequal against a probe that happened
			// not to end with one.
			expect(capturedRows('a\nb\n')).toBe(2)
			expect(capturedRows('a\nb')).toBe(2)
		})

		it('counts an empty capture as zero rows, not one', () => {
			expect(capturedRows('')).toBe(0)
		})

		it('counts a blank row as a row when something follows it', () => {
			expect(capturedRows('a\n\nb')).toBe(3)
		})
	})

	describe('isReadTruncated', () => {
		it('is true when the deeper read returned rows the capture did not', () => {
			expect(isReadTruncated('b\nc', 'a\nb\nc')).toBe(true)
		})

		it('is false when the deeper read had nothing more to give', () => {
			// The backend clamped at the top of what it holds: the caller has everything there is.
			expect(isReadTruncated('a\nb', 'a\nb')).toBe(false)
		})

		it('is false when the deeper read somehow came back shorter', () => {
			// Never "negative truncation": fewer rows is not evidence of rows above, so the honest answer
			// is the same `false` an equal count gets.
			expect(isReadTruncated('a\nb\nc', 'c')).toBe(false)
		})

		it('judges row COUNTS, not text, so a re-rendered row is not mistaken for a dropped one', () => {
			// The two reads are not required to render the shared rows identically — herdr's probe reads a
			// different `--source`, and a backend may re-wrap. What both agree on is how many rows came back.
			expect(isReadTruncated('a\nb', 'x\ny')).toBe(false)
		})

		it('reports an empty capture against a non-empty deeper read as truncated', () => {
			expect(isReadTruncated('', 'a')).toBe(true)
			expect(isReadTruncated('', '')).toBe(false)
		})
	})
})
