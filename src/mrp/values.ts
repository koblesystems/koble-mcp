/** Reading EBMS values, and the rounding every planning figure goes through. */

/** A string field, trimmed; anything else is blank. */
export const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
/** A number field; anything else is 0. */
export const num = (value: unknown): number => (typeof value === "number" ? value : 0);
/** To four decimals, so sums of fractions do not drift. */
export const round = (value: number): number => Math.round(value * 10_000) / 10_000;
