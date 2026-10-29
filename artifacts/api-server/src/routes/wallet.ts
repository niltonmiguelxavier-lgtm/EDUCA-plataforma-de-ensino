import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db, educaUsers, walletEntries, withdrawalRequests } from "@workspace/db";
import { requireAdmin, requireEducaUser } from "../middlewares/educaAuth";
import { canWithdraw, fromCents, toCents } from "../lib/money";
import { audit, notify } from "../lib/notify";
import { getWalletSummary } from "../lib/wallet";

const router: IRouter = Router();

const METHODS = ["mpesa", "emola"] as const;
type Method = (typeof METHODS)[number];
const STATUS_FILTERS = ["requested", "approved", "paid", "rejected", "cancelled"] as const;

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function requireTeacher(role: string | undefined, res: { status(c: number): { json(b: unknown): void } }): boolean {
  if (role !== "teacher") {
    res.status(403).json({ error: "A carteira está disponível para professores." });
    return false;
  }
  return true;
}

// A carteira é um registo contabilístico interno, não uma conta bancária.
const WALLET_NOTICE =
  "A carteira EDUCA é um registo interno dos valores das tuas aulas. Não é uma conta bancária.";

router.get("/wallet", requireEducaUser, async (req, res): Promise<void> => {
  if (!requireTeacher(req.educaUser!.role, res)) return;
  const teacherId = req.educaUser!.id;
  const [summary, entries, withdrawals] = await Promise.all([
    getWalletSummary(db, teacherId),
    db
      .select()
      .from(walletEntries)
      .where(eq(walletEntries.teacherId, teacherId))
      .orderBy(desc(walletEntries.createdAt))
      .limit(100),
    db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.teacherId, teacherId))
      .orderBy(desc(withdrawalRequests.createdAt))
      .limit(50),
  ]);
  const { withdrawableCents: _omit, ...publicSummary } = summary;
  res.json({ notice: WALLET_NOTICE, summary: publicSummary, entries, withdrawals });
});

router.post("/wallet/withdrawals", requireEducaUser, async (req, res): Promise<void> => {
  if (!requireTeacher(req.educaUser!.role, res)) return;
  const body = asRecord(req.body);
  const method = body.method;
  const destination = typeof body.destination === "string" ? body.destination.trim() : "";
  let amountCents: number;
  try {
    amountCents = toCents(body.amount as string | number);
  } catch {
    res.status(400).json({ error: "Indique um valor válido." });
    return;
  }
  if (!METHODS.includes(method as Method)) {
    res.status(400).json({ error: "Escolha M-Pesa ou e-Mola." });
    return;
  }
  if (!/^\+?\d{9,15}$/.test(destination)) {
    res.status(400).json({ error: "Indique um número de telemóvel válido." });
    return;
  }

  const teacherId = req.educaUser!.id;
  try {
    const created = await db.transaction(async (tx) => {
      // Bloqueia a linha do professor para impedir dois pedidos em simultâneo
      // que, juntos, ultrapassem o saldo.
      await tx.select({ id: educaUsers.id }).from(educaUsers).where(eq(educaUsers.id, teacherId)).for("update");
      const summary = await getWalletSummary(tx, teacherId);
      if (!canWithdraw(summary.withdrawableCents, amountCents)) {
        throw new Error("INSUFFICIENT_BALANCE");
      }
      const [row] = await tx
        .insert(withdrawalRequests)
        .values({
          id: randomUUID(),
          teacherId,
          amount: fromCents(amountCents),
          method: method as Method,
          destination,
        })
        .returning();
      await audit(tx, {
        actorId: teacherId,
        action: "withdrawal.requested",
        entityType: "withdrawal_request",
        entityId: row.id,
        details: { amount: row.amount, method: row.method },
      });
      await notify(tx, {
        userId: teacherId,
        type: "withdrawal.requested",
        title: "Pedido de levantamento registado",
        body: "O pedido aguarda a análise da administração. Nenhuma transferência foi feita ainda.",
        entityType: "withdrawal_request",
        entityId: row.id,
      });
      return row;
    });
    res.status(201).json({
      withdrawal: created,
      notice: "Pedido registado. O valor só é transferido depois de aprovado e confirmado por um fornecedor de pagamentos.",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      res.status(409).json({ error: "O valor excede o saldo disponível para levantamento." });
      return;
    }
    throw error;
  }
});

router.get("/admin/withdrawals", requireEducaUser, requireAdmin, async (req, res): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const filter = (STATUS_FILTERS as readonly string[]).includes(status)
    ? eq(withdrawalRequests.status, status as (typeof STATUS_FILTERS)[number])
    : undefined;
  const items = await db
    .select()
    .from(withdrawalRequests)
    .where(filter)
    .orderBy(desc(withdrawalRequests.createdAt))
    .limit(200);
  res.json({ items });
});

router.post(
  "/admin/withdrawals/:id/decision",
  requireEducaUser,
  requireAdmin,
  async (req, res): Promise<void> => {
    const body = asRecord(req.body);
    const decision = body.decision;
    const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 1000) : null;
    const providerReference =
      typeof body.providerReference === "string" && body.providerReference.trim()
        ? body.providerReference.trim().slice(0, 200)
        : null;
    if (decision !== "approve" && decision !== "reject" && decision !== "mark_paid") {
      res.status(400).json({ error: "Decisão inválida." });
      return;
    }
    if (decision === "reject" && !notes) {
      res.status(400).json({ error: "Indique o motivo da rejeição." });
      return;
    }
    if (decision === "mark_paid" && !providerReference) {
      res.status(400).json({
        error: "Só é possível marcar como pago com a referência de confirmação do fornecedor de pagamentos.",
      });
      return;
    }

    const adminId = req.educaUser!.id;
    try {
      const updated = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(withdrawalRequests)
          .where(eq(withdrawalRequests.id, String(req.params.id)))
          .for("update")
          .limit(1);
        if (!current) throw new Error("NOT_FOUND");

        const allowed =
          (decision === "approve" && current.status === "requested") ||
          (decision === "reject" && (current.status === "requested" || current.status === "approved")) ||
          (decision === "mark_paid" && current.status === "approved");
        if (!allowed) throw new Error("INVALID_TRANSITION");

        const nextStatus = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "paid";
        const [row] = await tx
          .update(withdrawalRequests)
          .set({
            status: nextStatus,
            decidedBy: adminId,
            decidedAt: new Date(),
            decisionNotes: notes,
            ...(decision === "mark_paid" ? { providerReference } : {}),
          })
          .where(eq(withdrawalRequests.id, current.id))
          .returning();

        if (decision === "mark_paid") {
          // Só aqui o saldo disponível diminui, com um movimento auditável e idempotente.
          await tx
            .insert(walletEntries)
            .values({
              id: randomUUID(),
              teacherId: current.teacherId,
              type: "withdrawal",
              bucket: "available",
              amount: fromCents(-toCents(current.amount)),
              idempotencyKey: `withdrawal:${current.id}`,
              description: "Levantamento pago",
              createdBy: adminId,
            })
            .onConflictDoNothing();
        }

        await audit(tx, {
          actorId: adminId,
          action: `withdrawal.${nextStatus}`,
          entityType: "withdrawal_request",
          entityId: current.id,
          details: { notes, providerReference, amount: current.amount },
        });
        await notify(tx, {
          userId: current.teacherId,
          type: `withdrawal.${nextStatus}`,
          title:
            nextStatus === "approved"
              ? "Levantamento aprovado"
              : nextStatus === "paid"
                ? "Levantamento pago"
                : "Levantamento rejeitado",
          body: notes,
          entityType: "withdrawal_request",
          entityId: current.id,
        });
        return row;
      });
      res.json({ withdrawal: updated });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "NOT_FOUND") {
        res.status(404).json({ error: "Pedido não encontrado." });
        return;
      }
      if (code === "INVALID_TRANSITION") {
        res.status(409).json({ error: "Esta decisão não é possível no estado actual do pedido." });
        return;
      }
      throw error;
    }
  },
);

export default router;
