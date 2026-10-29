import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db, educaUsers, lessonReviews, lessons, reports } from "@workspace/db";
import { requireAdmin, requireEducaUser } from "../middlewares/educaAuth";
import { audit, notify } from "../lib/notify";

const router: IRouter = Router();

const TARGET_TYPES = ["review", "lesson", "user"] as const;
type TargetType = (typeof TARGET_TYPES)[number];
const STATUS_FILTERS = ["open", "in_review", "resolved", "dismissed"] as const;

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

async function targetExists(type: TargetType, id: string): Promise<boolean> {
  if (type === "review") {
    const [row] = await db.select({ id: lessonReviews.id }).from(lessonReviews).where(eq(lessonReviews.id, id)).limit(1);
    return Boolean(row);
  }
  if (type === "lesson") {
    const [row] = await db.select({ id: lessons.id }).from(lessons).where(eq(lessons.id, id)).limit(1);
    return Boolean(row);
  }
  const [row] = await db.select({ id: educaUsers.id }).from(educaUsers).where(eq(educaUsers.id, id)).limit(1);
  return Boolean(row);
}

router.post("/reports", requireEducaUser, async (req, res): Promise<void> => {
  const body = asRecord(req.body);
  const targetType = body.targetType;
  const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const details = typeof body.details === "string" && body.details.trim() ? body.details.trim() : null;

  if (!TARGET_TYPES.includes(targetType as TargetType) || !targetId) {
    res.status(400).json({ error: "Indique o que pretende denunciar." });
    return;
  }
  if (reason.length < 3 || reason.length > 200 || (details && details.length > 2000)) {
    res.status(400).json({ error: "Indique um motivo entre 3 e 200 caracteres." });
    return;
  }
  if (!(await targetExists(targetType as TargetType, targetId))) {
    res.status(404).json({ error: "O item denunciado não foi encontrado." });
    return;
  }
  if (targetType === "user" && targetId === req.educaUser!.id) {
    res.status(400).json({ error: "Não é possível denunciar a própria conta." });
    return;
  }

  try {
    const [created] = await db
      .insert(reports)
      .values({
        id: randomUUID(),
        reporterId: req.educaUser!.id,
        targetType: targetType as TargetType,
        targetId,
        reason,
        details,
      })
      .returning();
    if (targetType === "review") {
      await db.update(lessonReviews).set({ isFlagged: true }).where(eq(lessonReviews.id, targetId));
    }
    res.status(201).json({ report: created });
  } catch (error) {
    if (pgCode(error) === "23505") {
      res.status(409).json({ error: "Já existe uma denúncia sua em análise para este item." });
      return;
    }
    throw error;
  }
});

router.get("/admin/reports", requireEducaUser, requireAdmin, async (req, res): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const filter = (STATUS_FILTERS as readonly string[]).includes(status)
    ? eq(reports.status, status as (typeof STATUS_FILTERS)[number])
    : undefined;
  const items = await db.select().from(reports).where(filter).orderBy(desc(reports.createdAt)).limit(200);
  res.json({ items });
});

router.post("/admin/reports/:id/resolve", requireEducaUser, requireAdmin, async (req, res): Promise<void> => {
  const body = asRecord(req.body);
  const action = body.action;
  const resolution = typeof body.resolution === "string" ? body.resolution.trim().slice(0, 1000) : "";
  if (action !== "dismiss" && action !== "resolve" && action !== "hide_review") {
    res.status(400).json({ error: "Acção inválida." });
    return;
  }
  if (!resolution) {
    res.status(400).json({ error: "Indique o motivo da decisão." });
    return;
  }

  const adminId = req.educaUser!.id;
  try {
    const updated = await db.transaction(async (tx) => {
      const [report] = await tx
        .select()
        .from(reports)
        .where(eq(reports.id, String(req.params.id)))
        .for("update")
        .limit(1);
      if (!report) throw new Error("NOT_FOUND");
      if (report.status === "resolved" || report.status === "dismissed") throw new Error("ALREADY_CLOSED");
      if (action === "hide_review" && report.targetType !== "review") throw new Error("NOT_A_REVIEW");

      if (action === "hide_review") {
        await tx.update(lessonReviews).set({ isVisible: false }).where(eq(lessonReviews.id, report.targetId));
      }
      const [row] = await tx
        .update(reports)
        .set({
          status: action === "dismiss" ? "dismissed" : "resolved",
          resolvedBy: adminId,
          resolution,
        })
        .where(eq(reports.id, report.id))
        .returning();

      await audit(tx, {
        actorId: adminId,
        action: `report.${action}`,
        entityType: "report",
        entityId: report.id,
        details: { targetType: report.targetType, targetId: report.targetId, resolution },
      });
      await notify(tx, {
        userId: report.reporterId,
        type: "report.closed",
        title: "A tua denúncia foi analisada",
        body: resolution,
        entityType: "report",
        entityId: report.id,
      });
      return row;
    });
    res.json({ report: updated });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const map: Record<string, [number, string]> = {
      NOT_FOUND: [404, "Denúncia não encontrada."],
      ALREADY_CLOSED: [409, "Esta denúncia já foi encerrada."],
      NOT_A_REVIEW: [400, "Só é possível ocultar avaliações."],
    };
    if (map[code]) {
      res.status(map[code][0]).json({ error: map[code][1] });
      return;
    }
    throw error;
  }
});

export default router;
