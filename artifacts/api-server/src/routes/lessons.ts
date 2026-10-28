import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, ne } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  lessonEnrollments,
  lessonReviews,
  lessons,
} from "@workspace/db";
import {
  CompleteLessonParams,
  CompleteLessonResponse,
  CreateLessonBody,
  CreateLessonResponse,
  CreateLessonReviewBody,
  CreateLessonReviewParams,
  CreateLessonReviewResponse,
  EnrollInLessonParams,
  EnrollInLessonResponse,
  ListLessonsResponse,
} from "@workspace/api-zod";
import {
  requireApprovedTeacher,
  requireEducaUser,
} from "../middlewares/educaAuth";
import { mapLessonsForDashboard } from "../lib/lesson-data";

const router: IRouter = Router();

router.get("/lessons", requireEducaUser, async (req, res): Promise<void> => {
  const user = req.educaUser!;
  let rows: (typeof lessons.$inferSelect)[];
  if (user.role === "teacher") {
    rows = await db
      .select()
      .from(lessons)
      .where(eq(lessons.teacherId, user.id))
      .orderBy(desc(lessons.startsAt));
  } else if (user.role === "admin") {
    rows = await db.select().from(lessons).orderBy(desc(lessons.startsAt));
  } else {
    const enrolledLessonRows = await db
      .select({ lessonId: lessonEnrollments.lessonId })
      .from(lessonEnrollments)
      .where(
        and(
          eq(lessonEnrollments.studentId, user.id),
          ne(lessonEnrollments.status, "cancelled"),
        ),
      );
    const enrolledIds = enrolledLessonRows.map((item) => item.lessonId);
    rows = await db
      .select()
      .from(lessons)
      .where(
        and(
          eq(lessons.status, "scheduled"),
          enrolledIds.length
            ? inArray(lessons.id, enrolledIds)
            : eq(lessons.status, "scheduled"),
        ),
      )
      .orderBy(desc(lessons.startsAt));
    const availableRows = await db
      .select()
      .from(lessons)
      .where(and(eq(lessons.status, "scheduled"), ne(lessons.teacherId, user.id)))
      .orderBy(desc(lessons.startsAt));
    const byId = new Map([...rows, ...availableRows].map((lesson) => [lesson.id, lesson]));
    rows = [...byId.values()].sort(
      (a, b) => b.startsAt.getTime() - a.startsAt.getTime(),
    );
  }
  res.json(ListLessonsResponse.parse(await mapLessonsForDashboard(rows)));
});

router.post(
  "/lessons",
  requireEducaUser,
  requireApprovedTeacher,
  async (req, res): Promise<void> => {
    const parsed = CreateLessonBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const lessonId = randomUUID();
    const [lesson] = await db
      .insert(lessons)
      .values({
        id: lessonId,
        teacherId: req.educaUser!.id,
        subject: parsed.data.subject,
        level: parsed.data.level,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        startsAt: new Date(parsed.data.startsAt),
        durationMinutes: parsed.data.durationMinutes,
        capacity: parsed.data.capacity,
        modality: parsed.data.modality,
        hourlyRateMzn:
          parsed.data.hourlyRateMzn == null
            ? null
            : String(parsed.data.hourlyRateMzn),
      })
      .returning();
    const [mapped] = await mapLessonsForDashboard([lesson]);
    res.status(201).json(CreateLessonResponse.parse(mapped));
  },
);

router.post(
  "/lessons/:lessonId/enroll",
  requireEducaUser,
  async (req, res): Promise<void> => {
    const params = EnrollInLessonParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (req.educaUser!.role !== "student") {
      res.status(403).json({ error: "A inscrição está disponível para estudantes." });
      return;
    }

    try {
      const enrollment = await db.transaction(async (tx) => {
        const [lesson] = await tx
          .select()
          .from(lessons)
          .where(eq(lessons.id, params.data.lessonId))
          .for("update")
          .limit(1);
        if (!lesson) {
          throw new Error("LESSON_NOT_FOUND");
        }
        if (lesson.status !== "scheduled" || lesson.startsAt <= new Date()) {
          throw new Error("LESSON_NOT_OPEN");
        }
        const [existing] = await tx
          .select({ id: lessonEnrollments.id })
          .from(lessonEnrollments)
          .where(
            and(
              eq(lessonEnrollments.lessonId, lesson.id),
              eq(lessonEnrollments.studentId, req.educaUser!.id),
            ),
          )
          .limit(1);
        if (existing) {
          throw new Error("ALREADY_ENROLLED");
        }
        const [currentCount] = await tx
          .select({ value: count() })
          .from(lessonEnrollments)
          .where(
            and(
              eq(lessonEnrollments.lessonId, lesson.id),
              ne(lessonEnrollments.status, "cancelled"),
            ),
          );
        if (Number(currentCount?.value ?? 0) >= lesson.capacity) {
          throw new Error("LESSON_FULL");
        }
        const [created] = await tx
          .insert(lessonEnrollments)
          .values({
            id: randomUUID(),
            lessonId: lesson.id,
            studentId: req.educaUser!.id,
          })
          .returning();
        return created;
      });
      res.status(201).json(
        EnrollInLessonResponse.parse({
          id: enrollment.id,
          lessonId: enrollment.lessonId,
          studentId: enrollment.studentId,
          status: enrollment.status,
          createdAt: enrollment.createdAt,
        }),
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const status =
        code === "LESSON_NOT_FOUND"
          ? 404
          : code === "LESSON_FULL" || code === "ALREADY_ENROLLED"
            ? 409
            : code === "LESSON_NOT_OPEN"
              ? 400
              : 500;
      if (status === 500) throw error;
      res.status(status).json({
        error:
          code === "LESSON_NOT_FOUND"
            ? "Aula não encontrada."
            : code === "LESSON_FULL"
              ? "Esta aula já não tem vagas."
              : code === "ALREADY_ENROLLED"
                ? "Já está inscrito nesta aula."
                : "As inscrições para esta aula estão encerradas.",
      });
    }
  },
);

router.post(
  "/lessons/:lessonId/complete",
  requireEducaUser,
  requireApprovedTeacher,
  async (req, res): Promise<void> => {
    const params = CompleteLessonParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [lesson] = await db
      .select()
      .from(lessons)
      .where(
        and(
          eq(lessons.id, params.data.lessonId),
          eq(lessons.teacherId, req.educaUser!.id),
        ),
      )
      .limit(1);
    if (!lesson) {
      res.status(404).json({ error: "Aula não encontrada." });
      return;
    }
    const [enrolled] = await db
      .select({ value: count() })
      .from(lessonEnrollments)
      .where(
        and(
          eq(lessonEnrollments.lessonId, lesson.id),
          ne(lessonEnrollments.status, "cancelled"),
        ),
      );
    if (
      lesson.status !== "scheduled" ||
      lesson.startsAt > new Date() ||
      Number(enrolled?.value ?? 0) === 0
    ) {
      res.status(409).json({
        error: "A aula só pode ser concluída após a hora marcada e com participantes inscritos.",
      });
      return;
    }
    const [completed] = await db
      .update(lessons)
      .set({ status: "completed" })
      .where(eq(lessons.id, lesson.id))
      .returning();
    const [mapped] = await mapLessonsForDashboard([completed]);
    res.json(CompleteLessonResponse.parse(mapped));
  },
);

router.post(
  "/lessons/:lessonId/reviews",
  requireEducaUser,
  async (req, res): Promise<void> => {
    const params = CreateLessonReviewParams.safeParse(req.params);
    const parsed = CreateLessonReviewBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [lesson] = await db
      .select()
      .from(lessons)
      .where(eq(lessons.id, params.data.lessonId))
      .limit(1);
    if (!lesson) {
      res.status(404).json({ error: "Aula não encontrada." });
      return;
    }
    if (lesson.teacherId === req.educaUser!.id) {
      res.status(403).json({ error: "Não é possível avaliar a própria aula." });
      return;
    }
    if (lesson.status !== "completed") {
      res.status(409).json({ error: "Só é possível avaliar uma aula concluída." });
      return;
    }
    const [enrollment] = await db
      .select({ id: lessonEnrollments.id })
      .from(lessonEnrollments)
      .where(
        and(
          eq(lessonEnrollments.lessonId, lesson.id),
          eq(lessonEnrollments.studentId, req.educaUser!.id),
          ne(lessonEnrollments.status, "cancelled"),
        ),
      )
      .limit(1);
    if (!enrollment) {
      res.status(403).json({ error: "É necessário estar inscrito nesta aula." });
      return;
    }
    const [existing] = await db
      .select({ id: lessonReviews.id })
      .from(lessonReviews)
      .where(
        and(
          eq(lessonReviews.lessonId, lesson.id),
          eq(lessonReviews.studentId, req.educaUser!.id),
        ),
      )
      .limit(1);
    if (existing) {
      res.status(409).json({ error: "Já avaliou esta aula." });
      return;
    }
    const [review] = await db
      .insert(lessonReviews)
      .values({
        id: randomUUID(),
        lessonId: lesson.id,
        studentId: req.educaUser!.id,
        teacherId: lesson.teacherId,
        stars: parsed.data.stars,
        clarity: parsed.data.clarity ?? null,
        helpful: parsed.data.helpful ?? null,
        recommend: parsed.data.recommend ?? null,
        comment: parsed.data.comment ?? null,
      })
      .returning();
    res.status(201).json(
      CreateLessonReviewResponse.parse({
        stars: review.stars,
        clarity: review.clarity,
        helpful: review.helpful,
        recommend: review.recommend,
        comment: review.comment,
        id: review.id,
        lessonId: review.lessonId,
        teacherId: review.teacherId,
        studentId: review.studentId,
        createdAt: review.createdAt,
      }),
    );
  },
);

export default router;
