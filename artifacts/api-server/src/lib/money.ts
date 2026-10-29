// Aritmética monetária em cêntimos (inteiros). Nunca usar números decimais
// para somar ou dividir dinheiro. Este ficheiro não tem dependências.

export function toCents(value: string | number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error("INVALID_AMOUNT");
  }
  return Math.round(n * 100);
}

export function fromCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error("INVALID_AMOUNT");
  }
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// 12,5 % -> 1250 pontos-base.
export function percentageToBps(percentage: number): number {
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new Error("INVALID_RATE");
  }
  return Math.round(percentage * 100);
}

export function splitCommission(
  amountCents: number,
  rateBps: number,
): { commissionCents: number; teacherCents: number } {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("INVALID_AMOUNT");
  }
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
    throw new Error("INVALID_RATE");
  }
  const commissionCents = Math.round((amountCents * rateBps) / 10000);
  return { commissionCents, teacherCents: amountCents - commissionCents };
}

// Um pedido só é possível se o valor for positivo e não exceder o saldo
// disponível já deduzido dos pedidos em aberto.
export function canWithdraw(withdrawableCents: number, requestedCents: number): boolean {
  return Number.isInteger(requestedCents) && requestedCents > 0 && requestedCents <= withdrawableCents;
}
