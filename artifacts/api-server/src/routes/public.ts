import { and, avg, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  educaUsers,
  examResources,
  lessonReviews,
  lessons,
  platformSettings,
  subjects,
  teacherProfiles,
} from "@workspace/db";
import {
  GetPublicStatsResponse,
  GetTeacherParams,
  GetTeacherRankingsQueryParams,
  GetTeacherRankingsResponse,
  GetTeacherResponse,
  ListExamResourcesQueryParams,
  ListExamResourcesResponse,
  ListSubjectsResponse,
  ListTeachersQueryParams,
  ListTeachersResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

type PublicTeacher = {
  id: string;
  name: string;
  photoUrl: string | null;
  bio: string;
  subjects: string[];
  levels: string[];
  rating: number | null;
  reviewCount: number;
  completedLessons: number;
  hourlyRateMzn: number | null;
  modalities: ("individual" | "group")[];
};

export async function getPublicTeachers(filters?: {
  subject?: string;
  level?: string;
  query?: string;
}): Promise<PublicTeacher[]> {
  const conditions = [
    eq(educaUsers.role, "teacher"),
    eq(teacherProfiles.isActive, true),
  ];
  if (filters?.subject) {
    conditions.push(
      sql`${teacherProfiles.subjects} @> ARRAY[${filters.subject}]::text[]`,
    );
  }
  if (filters?.level) {
    conditions.push(sql`${teacherProfiles.levels} @> ARRAY[${filters.level}]::text[]`);
  }
  if (filters?.query?.trim()) {
    const search = `%${filters.query.trim()}%`;
    conditions.push(or(ilike(educaUsers.name, search), ilike(teacherProfiles.bio, search))!);
  }

  const rows = await db
    .select({
      id: teacherProfiles.userId,
      name: educaUsers.name,
      photoUrl: teacherProfiles.photoUrl,
      bio: teacherProfiles.bio,
      subjects: teacherProfiles.subjects,
      levels: teacherProfiles.levels,
      hourlyRateMzn: teacherProfiles.hourlyRateMzn,
      modalities: teacherProfiles.modalities,
    })
    .from(teacherProfiles)
    .innerJoin(educaUsers, eq(educaUsers.id, teacherProfiles.userId))
    .where(and(...conditions))
    .orderBy(educaUsers.name);

  if (rows.length === 0) return [];
  const teacherIds = rows.map((row) => row.id);
  const [reviewRows, completedRows] = await Promise.all([
    db
      .select({
        teacherId: lessonReviews.teacherId,
        reviewCount: count(lessonReviews.id),
        rating: avg(lessonReviews.stars),
      })
      .from(lessonReviews)
      .where(
        and(
          inArray(lessonReviews.teacherId, teacherIds),
          eq(lessonReviews.isVisible, true),
          eq(lessonReviews.isFlagged, false),
        ),
      )
      .groupBy(lessonReviews.teacherId),
    db
      .select({ teacherId: lessons.teacherId, completedLessons: count(lessons.id) })
      .from(lessons)
      .where(
        and(
          inArray(lessons.teacherId, teacherIds),
          eq(lessons.status, "completed"),
        ),
      )
      .groupBy(lessons.teacherId),
  ]);

  const reviewsByTeacher = new Map(
    reviewRows.map((row) => [
      row.teacherId,
      {
        count: Number(row.reviewCount),
        rating: row.rating == null ? null : Number(row.rating),
      },
    ]),
  );
  const lessonsByTeacher = new Map(
    completedRows.map((row) => [row.teacherId, Number(row.completedLessons)]),
  );

  return rows
    .filter((row): row is typeof row & { name: string } => row.name !== null)
    .map((row) => ({
      id: row.id,
      name: row.name,
      photoUrl: row.photoUrl,
      bio: row.bio,
      subjects: row.subjects,
      levels: row.levels,
      rating: reviewsByTeacher.get(row.id)?.rating ?? null,
      reviewCount: reviewsByTeacher.get(row.id)?.count ?? 0,
      completedLessons: lessonsByTeacher.get(row.id) ?? 0,
      hourlyRateMzn:
        row.hourlyRateMzn == null ? null : Number(row.hourlyRateMzn),
      modalities: row.modalities.filter(
        (modality): modality is "individual" | "group" =>
          modality === "individual" || modality === "group",
      ),
    }));
}

router.get("/public/stats", async (_req, res): Promise<void> => {
  const [[teacherCount], [completedCount], [subjectCount]] = await Promise.all([
    db
      .select({ value: count() })
      .from(teacherProfiles)
      .innerJoin(educaUsers, eq(educaUsers.id, teacherProfiles.userId))
      .where(and(eq(educaUsers.role, "teacher"), eq(teacherProfiles.isActive, true))),
    db.select({ value: count() }).from(lessons).where(eq(lessons.status, "completed")),
    db.select({ value: count() }).from(subjects).where(eq(subjects.isActive, true)),
  ]);
  res.json(
    GetPublicStatsResponse.parse({
      approvedTeachers: Number(teacherCount?.value ?? 0),
      completedLessons: Number(completedCount?.value ?? 0),
      activeSubjects: Number(subjectCount?.value ?? 0),
    }),
  );
});

router.get("/subjects", async (_req, res): Promise<void> => {
  const data = await db
    .select({ id: subjects.id, name: subjects.name, levels: subjects.levels })
    .from(subjects)
    .where(eq(subjects.isActive, true))
    .orderBy(subjects.name);
  res.json(ListSubjectsResponse.parse(data));
});

router.get("/teachers", async (req, res): Promise<void> => {
  const parsed = ListTeachersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const teachers = await getPublicTeachers(parsed.data);
  const filtered =
    parsed.data.minRating === undefined
      ? teachers
      : teachers.filter(
          (teacher) =>
            teacher.rating !== null && teacher.rating >= parsed.data.minRating!,
        );
  res.json(ListTeachersResponse.parse(filtered));
});

router.get("/teachers/:teacherId", async (req, res): Promise<void> => {
  const params = GetTeacherParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const allTeachers = await getPublicTeachers();
  const result = allTeachers.find((item) => item.id === params.data.teacherId);
  if (!result) {
    res.status(404).json({ error: "Professor não encontrado." });
    return;
  }
  res.json(GetTeacherResponse.parse(result));
});

router.get("/rankings", async (req, res): Promise<void> => {
  const parsed = GetTeacherRankingsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const teachers = await getPublicTeachers(parsed.data);
  const teacherIds = teachers.map((teacher) => teacher.id);
  if (teacherIds.length === 0) {
    res.json(GetTeacherRankingsResponse.parse({ ranked: [], newTalents: [] }));
    return;
  }

  const [settings, ratingDistribution, lessonHistory] = await Promise.all([
    // Ranking thresholds remain server-side configuration.
    db.select().from(platformSettings),
    db
      .select({
        teacherId: lessonReviews.teacherId,
        stars: lessonReviews.stars,
        count: count(),
      })
      .from(lessonReviews)
      .where(
        and(
          inArray(lessonReviews.teacherId, teacherIds),
          eq(lessonReviews.isVisible, true),
          eq(lessonReviews.isFlagged, false),
        ),
      )
      .groupBy(lessonReviews.teacherId, lessonReviews.stars),
    db
      .select({
        teacherId: lessons.teacherId,
        completed: count(sql`case when ${lessons.status} = 'completed' then 1 end`),
        due: count(),
      })
      .from(lessons)
      .where(
        and(inArray(lessons.teacherId, teacherIds), sql`${lessons.startsAt} < now()`),
      )
      .groupBy(lessons.teacherId),
  ]);
  const lessonCapSetting = settings.find((item) => item.key === "ranking_lesson_cap");
  const lessonCapValue =
    lessonCapSetting?.value &&
    typeof lessonCapSetting.value === "object" &&
    "count" in lessonCapSetting.value
      ? Number(lessonCapSetting.value.count)
      : 50;
  const lessonCap = Number.isFinite(lessonCapValue) && lessonCapValue > 0 ? lessonCapValue : 50;
  const positiveByTeacher = new Map<string, { total: number; positive: number }>();
  for (const row of ratingDistribution) {
    const current = positiveByTeacher.get(row.teacherId) ?? { total: 0, positive: 0 };
    const rowCount = Number(row.count);
    current.total += rowCount;
    if (row.stars >= 4) current.positive += rowCount;
    positiveByTeacher.set(row.teacherId, current);
  }
  const sessionByTeacher = new Map(
    lessonHistory.map((row) => [
      row.teacherId,
      {
        completed: Number(row.completed),
        due: Number(row.due),
      },
    ]),
  );

  const rankedWithScores = teachers
    .filter((teacher) => teacher.reviewCount >= 3)
    .map((teacher) => {
      const priorMean = 4.2;
      const priorReviews = 5;
      const adjustedRating =
        ((teacher.rating ?? priorMean) * teacher.reviewCount +
          priorMean * priorReviews) /
        (teacher.reviewCount + priorReviews);
      const ratingsScore = (adjustedRating / 5) * 100;
      const lessonScore = Math.min(100, (teacher.completedLessons / lessonCap) * 100);
      const positive = positiveByTeacher.get(teacher.id) ?? { total: 0, positive: 0 };
      const positiveScore =
        positive.total === 0 ? 0 : (positive.positive / positive.total) * 100;
      const history = sessionByTeacher.get(teacher.id) ?? { completed: 0, due: 0 };
      const punctualityScore =
        history.due === 0 ? 0 : (history.completed / history.due) * 100;
      const score =
        ratingsScore * 0.6 +
        lessonScore * 0.2 +
        positiveScore * 0.1 +
        punctualityScore * 0.1;
      return { ...teacher, score: Math.round(score * 100) / 100 };
    })
    .sort((a, b) => b.score - a.score)
    .map((teacher, index) => ({ ...teacher, position: index + 1 }));
  const newTalents = teachers.filter((teacher) => teacher.reviewCount < 3);
  res.json(
    GetTeacherRankingsResponse.parse({
      ranked: rankedWithScores,
      newTalents,
    }),
  );
});

router.get("/exam-resources", async (req, res): Promise<void> => {
  const parsed = ListExamResourcesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const filters = [eq(examResources.isPublished, true)];
  if (parsed.data.subject) filters.push(eq(examResources.subject, parsed.data.subject));
  if (parsed.data.level) filters.push(eq(examResources.level, parsed.data.level));
  if (parsed.data.institution) {
    filters.push(eq(examResources.institution, parsed.data.institution));
  }
  if (parsed.data.exam) filters.push(eq(examResources.exam, parsed.data.exam));
  const data = await db
    .select({
      id: examResources.id,
      title: examResources.title,
      institution: examResources.institution,
      exam: examResources.exam,
      subject: examResources.subject,
      level: examResources.level,
      topic: examResources.topic,
      resourceType: examResources.resourceType,
      description: examResources.description,
      source: examResources.source,
      url: examResources.url,
    })
    .from(examResources)
    .where(and(...filters))
    .orderBy(desc(examResources.updatedAt));
  res.json(ListExamResourcesResponse.parse(data));
});

export default router;
