/**
 * Exact decimal arithmetic for the open record, on BigInt.
 *
 * Canton amounts are Daml Decimals with 10 fractional digits, and supply needs
 * about 21 significant digits (39,681,534,966.2458918175), more than a double
 * holds. Values are carried as bigint scaled by 10^20, so the product of two
 * 10-place decimals (a coupon total times an issuance rate) is exact, and are
 * rounded to 10 places only when published.
 *
 * No BigInt literals, so the module also compiles for an ES2017 target.
 */

export type Dec = bigint;

export const DEC_SCALE_DIGITS = 20;
const SCALE = BigInt(10) ** BigInt(DEC_SCALE_DIGITS);
const ZERO = BigInt(0);
const TWO = BigInt(2);
const NUMBER_RE = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Parse "123.45", "-1", "0E-10", "1.5E+3". Digits past 20 places are truncated. */
export function dec(input: string): Dec {
  const m = NUMBER_RE.exec(input.trim());
  if (!m) throw new Error(`not a decimal: ${input}`);
  const sign = m[1];
  const intPart = m[2];
  const fracPart = m[3] ?? "";
  const exponent = Number(m[4] ?? "0");
  const digits = BigInt(intPart + fracPart);
  const shift = DEC_SCALE_DIGITS + exponent - fracPart.length;
  const scaled = shift >= 0 ? digits * BigInt(10) ** BigInt(shift) : digits / BigInt(10) ** BigInt(-shift);
  return sign === "-" ? -scaled : scaled;
}

export function add(...values: Dec[]): Dec {
  return values.reduce((sum, v) => sum + v, ZERO);
}

export function mul(a: Dec, b: Dec): Dec {
  return (a * b) / SCALE;
}

export function abs(a: Dec): Dec {
  return a < ZERO ? -a : a;
}

/** Fixed point, half away from zero, no exponent, no thousands separator. */
export function format(value: Dec, digits = 10): string {
  const negative = value < ZERO;
  const magnitude = negative ? -value : value;
  const drop = BigInt(10) ** BigInt(DEC_SCALE_DIGITS - digits);
  const rounded = (magnitude + drop / TWO) / drop;
  const text = rounded.toString().padStart(digits + 1, "0");
  const intPart = text.slice(0, text.length - digits);
  const out = digits > 0 ? `${intPart}.${text.slice(text.length - digits)}` : intPart;
  return negative && rounded !== ZERO ? `-${out}` : out;
}
