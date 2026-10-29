import { and, eq, inArray, sql } from "drizzle-orm";
import { db, walletEntries, withdrawalRequests } from "@workspace/db";
import { fromCents, toCents } from "./money";

type Reader = Pick<typeof db, "select">;

export type WalletSummary = {
  pending: string;
  available: string;
  reservedForWithdrawals: string;
  withdrawable: string;
  totalSales: string;
  totalCommissions: string;
  withdrawableCents: number;
  currency: "MZN";
};

// Os saldos são sempre calculados a partir do livro de movimentos
// (wallet_entries). Nunca existe um saldo editável.
export async function getWalletSummary(executor: Reader, teacherId: string): Promise<WalletSummary> {
  const byBucket = await executor
    .select({
      bucket: walletEntries.bucket,
      total: sql<string>`coalesce(sum(${walletEntries.amount}), 0)`,
    })
    .from(walletEntries)
    .where(eq(walletEntries.teacherId, teacherId))
    .groupBy(walletEntries.bucket);

  const byType = await executor
    .select({
      type: walletEntries.type,
      total: sql<string>`coalesce(sum(${walletEntries.amount}), 0)`,
    })
    .from(walletEntries)
    .where(eq(walletEntries.teacherId, teacherId))
    .groupBy(walletEntries.type);

  const [reserved] = await executor
    .select({ total: sql<string>`coalesce(sum(${withdrawalRequests.amount}), 0)` })
    .from(withdrawalRequests)
    .where(
      and(
        eq(withdrawalRequests.teacherId, teacherId),
        inArray(withdrawalRequests.status, ["requested", "approved"]),
      ),
    );

  const pendingCents = toCents(byBucket.find((r) => r.bucket === "pending")?.total ?? 0);
  const availableCents = toCents(byBucket.find((r) => r.bucket === "available")?.total ?? 0);
  const reservedCents = toCents(reserved?.total ?? 0);
  const withdrawableCents = Math.max(0, availableCents - reservedCents);

  return {
    pending: fromCents(pendingCents),
    available: fromCents(availableCents),
    reservedForWithdrawals: fromCents(reservedCents),
    withdrawable: fromCents(withdrawableCents),
    totalSales: fromCents(toCents(byType.find((r) => r.type === "sale")?.total ?? 0)),
    totalCommissions: fromCents(toCents(byType.find((r) => r.type === "commission")?.total ?? 0)),
    withdrawableCents,
    currency: "MZN",
  };
}
