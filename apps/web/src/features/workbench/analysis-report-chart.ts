export type DecimalChartScale = {
  positions: (number | null)[];
  zero: number | null;
};

function decimal(value: string): { coefficient: bigint; scale: number } | null {
  if (value.length > 256 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > 254) return null;
  return { coefficient: BigInt(whole + fraction) * (negative ? -1n : 1n), scale: fraction.length };
}

// 原值始终保留为文本；只将归一化后的有界坐标转成Number。
export function decimalChartScale(values: readonly (string | null)[], includeZero = true): DecimalChartScale | null {
  const parsed = values.map(value => value === null ? null : decimal(value));
  if (parsed.some((value, index) => value === null && values[index] !== null)) return null;
  const present = parsed.filter(value => value !== null);
  if (!present.length) return null;
  const scale = Math.max(...present.map(value => value.scale));
  const scaled = parsed.map(value => value === null ? null : value.coefficient * 10n ** BigInt(scale - value.scale));
  const numbers = scaled.filter(value => value !== null);
  let low = numbers[0];
  let high = numbers[0];
  for (const value of numbers) { if (value < low) low = value; if (value > high) high = value; }
  if (includeZero) { if (low > 0n) low = 0n; if (high < 0n) high = 0n; }
  const range = high - low;
  const coordinate = (value: bigint) => range === 0n ? 0.5 : Number((value - low) * 1_000_000n / range) / 1_000_000;
  return {
    positions: scaled.map(value => value === null ? null : coordinate(value)),
    zero: low <= 0n && high >= 0n ? coordinate(0n) : null,
  };
}
