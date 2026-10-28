import { and, count, eq, inArray, ne } from "drizzle-orm";
import { db, educaUsers, lessonEnrollments, lessons } from "@workspace/db";

export async function mapLessonsForDashboard(
  rows: (typeof lessons.$inferSelect)[],
) {
  if (rows.length === 0) return [];
  const lessonIds = rows.map((lesson) => lesson.id);
  const teacherIds = [...new Set(rows.map((lesson) => lesson.teacherId))];
  const [teachers, enrollmentRows] = await Promise.all([
    db
      .select({ id: educaUsers.id, name: educaUsers.name })
      .from(educaUsers)
      .where(inArray(educaUsers.id, teacherIds)),
    db
      .select({ lessonId: lessonEnrollments.lessonId, count: count() })
      .from(lessonEnrollments)
      .where(
        and(
          inArray(lessonEnrollments.lessonId, lessonIds),
          ne(lessonEnrollments.status, "cancelled"),
        ),
      )
      .groupBy(lessonEnrollments.lessonId),
  ]);
  const names = new Map(teachers.map((teacher) => [teacher.id, teacher.name ?? ""]));
  const enrollmentCounts = new Map(
    enrollmentRows.map((item) => [item.lessonId, Number(item.count)]),
  );
  return rows.map((lesson) => ({
    id: lesson.id,
    teacherId: lesson.teacherId,
    teacherName: names.get(lesson.teacherId) ?? "",
    subject: lesson.subject,
    level: lesson.level,
    title: lesson.title,
    description: lesson.description,
    startsAt: lesson.startsAt,
    durationMinutes: lesson.durationMinutes,
    capacity: lesson.capacity,
    modality: lesson.modality,
    hourlyRateMzn:
      lesson.hourlyRateMzn === null ? null : Number(lesson.hourlyRateMzn),
    status: lesson.status,
    enrolledCount: enrollmentCounts.get(lesson.id) ?? 0,
    meetingUrl: null,
  }));
}
