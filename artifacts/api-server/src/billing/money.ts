export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function parseDollarsToCents(value: string): number {
  const normalized = value.trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Enter a dollar amount with no more than two decimal places.");
  }
  const negative = normalized.startsWith("-");
  const [whole, fraction = ""] = normalized.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error("Dollar amount is too large.");
  return negative ? -cents : cents;
}

export function centsToDollars(cents: number): number {
  if (!Number.isSafeInteger(cents)) throw new Error("Cents must be a safe integer.");
  return cents / 100;
}