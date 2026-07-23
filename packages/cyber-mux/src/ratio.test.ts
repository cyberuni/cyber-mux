import { describe, expect, it } from 'vitest'
import { assertRatioInRange } from './ratio.ts'

describe('assertRatioInRange', () => {
	it.each([0.001, 0.333, 0.5, 0.999])('passes a fraction strictly between 0 and 1: %s', (ratio) => {
		expect(() => assertRatioInRange(ratio)).not.toThrow()
	})

	// The two boundaries and everything outside them. 0 and 1 are degenerate (one side gets the whole
	// region, the other nothing); above 1 renders a negative split; NaN/Infinity are not a fraction at
	// all. Every one names the same rule so a caller reading the message knows what was expected.
	it.each([
		0,
		1,
		1.5,
		-0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	])('rejects a value outside 0 < ratio < 1: %s', (ratio) => {
		expect(() => assertRatioInRange(ratio)).toThrow(/ratio must be strictly between 0 and 1/)
	})
})
