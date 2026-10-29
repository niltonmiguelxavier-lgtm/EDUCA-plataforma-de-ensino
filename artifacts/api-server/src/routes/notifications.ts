import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db, notifications } from "@workspace/db";
import { requireEducaUser } from "../middlewares/educaAuth";

const router: IRouter = Router();

router.get("/notifications", requireEducaUser, async (req, res): Promise<void> => {
  const userId = req.educaUser!.id;
  const [items, [unread]] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(50),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
  ]);
  res.json({ unreadCount: unread?.value ?? 0, items });
});

router.post("/notifications/read-all", requireEducaUser, async (req, res): Promise<void> => {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, req.educaUser!.id), isNull(notifications.readAt)));
  res.json({ ok: true });
});

router.post("/notifications/:id/read", requireEducaUser, async (req, res): Promise<void> => {
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, String(req.params.id)),
        eq(notifications.userId, req.educaUser!.id),
      ),
    )
    .returning({ id: notifications.id });
  if (updated.length === 0) {
    res.status(404).json({ error: "Notificação não encontrada." });
    return;
  }
  res.json({ ok: true });
});

export default router;
