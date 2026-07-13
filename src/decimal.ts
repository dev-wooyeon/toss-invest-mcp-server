const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

type Decimal = {
  coefficient: bigint;
  scale: number;
};

/**
 * Parses non-negative decimal strings without converting through IEEE-754.
 * Monetary policy values must remain exact at their configured boundary.
 */
export function normalizeDecimal(value: string): string | undefined {
  const decimal = parseDecimal(value);
  return decimal ? formatDecimal(decimal) : undefined;
}

export function isPositiveDecimal(value: string): boolean {
  const decimal = parseDecimal(value);
  return decimal !== undefined && decimal.coefficient > 0n;
}

export function compareDecimals(left: string, right: string): number {
  const leftDecimal = requiredDecimal(left, "left decimal");
  const rightDecimal = requiredDecimal(right, "right decimal");
  const scale = Math.max(leftDecimal.scale, rightDecimal.scale);
  const leftValue = leftDecimal.coefficient * powerOfTen(scale - leftDecimal.scale);
  const rightValue = rightDecimal.coefficient * powerOfTen(scale - rightDecimal.scale);
  return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
}

export function multiplyDecimals(left: string, right: string): string {
  const leftDecimal = requiredDecimal(left, "left decimal");
  const rightDecimal = requiredDecimal(right, "right decimal");
  return formatDecimal({
    coefficient: leftDecimal.coefficient * rightDecimal.coefficient,
    scale: leftDecimal.scale + rightDecimal.scale,
  });
}

function parseDecimal(value: string): Decimal | undefined {
  if (!DECIMAL_PATTERN.test(value)) {
    return undefined;
  }
  const [whole, fraction = ""] = value.split(".");
  return {
    coefficient: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function requiredDecimal(value: string, label: string): Decimal {
  const decimal = parseDecimal(value);
  if (!decimal) {
    throw new Error(`${label} must be a non-negative decimal string.`);
  }
  return decimal;
}

function powerOfTen(exponent: number) {
  return 10n ** BigInt(exponent);
}

function formatDecimal(decimal: Decimal): string {
  const digits = decimal.coefficient.toString();
  if (decimal.scale === 0) {
    return digits;
  }

  const padded = digits.padStart(decimal.scale + 1, "0");
  const whole = padded.slice(0, -decimal.scale).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-decimal.scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
