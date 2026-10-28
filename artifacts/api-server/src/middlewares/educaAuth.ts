import { getAuth } from "@clerk/express";
import { and, desc, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  db,
  educaUsers,
  teacherApplications,
  teacherProfiles,
} from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      educaUser?: typeof educaUsers.$inferSelect;
    }
  }
}

export async function requireEducaUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "É necessário iniciar sessão." });
    return;
  }

  try {
    await db.insert(educaUsers).values({ id: userId }).onConflictDoNothing();
    const [user] = await db.select().from(educaUsers).where(eq(educaUsers.id, userId));
    if (!user) {
      res.status(500).json({ error: "Não foi possível carregar o perfil." });
      return;
    }
    req.educaUser = user;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.educaUser?.role !== "admin") {
    res.status(403).json({ error: "Acesso reservado à administração." });
    return;
  }
  next();
}

export async function requireApprovedTeacher(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = req.educaUser;
  if (!user || user.role !== "teacher") {
    res.status(403).json({ error: "Apenas professores aprovados podem gerir aulas." });
    return;
  }

  try {
    const [application] = await db
      .select({ status: teacherApplications.status })
      .from(teacherApplications)
      .where(eq(teacherApplications.applicantId, user.id))
      .orderBy(desc(teacherApplications.createdAt))
      .limit(1);
    const [profile] = await db
      .select({ isActive: teacherProfiles.isActive })
      .from(teacherProfiles)
      .where(eq(teacherProfiles.userId, user.id))
      .limit(1);

    if (application?.status !== "approved" || !profile?.isActive) {
      res.status(403).json({ error: "As funcionalidades de ensino estão bloqueadas." });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

export async function getTeacherStatus(userId: string): Promise<
  "pending" | "scheduled" | "in_review" | "approved" | "rejected" | "suspended" | null
> {
  const [application] = await db
    .select({ status: teacherApplications.status })
    .from(teacherApplications)
    .where(eq(teacherApplications.applicantId, userId))
    .orderBy(desc(teacherApplications.createdAt))
    .limit(1);
  return application?.status ?? null;
}
