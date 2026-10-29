import { randomUUID } from "node:crypto";
import { auditLogs, notifications, type db } from "@workspace/db";

type Writer = Pick<typeof db, "insert">;

export async function notify(
  executor: Writer,
  input: {
    userId: string;
    type: string;
    title: string;
    body?: string | null;
    entityType?: string | null;
    entityId?: string | null;
  },
): Promise<void> {
  await executor.insert(notifications).values({
    id: randomUUID(),
    userId: input.userId,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
  });
}

export async function audit(
  executor: Writer,
  input: {
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await executor.insert(auditLogs).values({
    id: randomUUID(),
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    details: input.details ?? {},
  });
}
