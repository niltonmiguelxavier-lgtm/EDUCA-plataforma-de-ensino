import { and, avg, count, desc, eq, inArray, ne } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  educaUsers,
  lessonEnrollments,
  lessonReviews,
  lessons,
  teacherApplications,
  teacherProfiles,
} from "@workspace/db";
import {
  GetAdminDashboardResponse,
  GetStudentDashboardResponse,
  GetTeacherDashboardResponse,
  ListTeacherApplicationsResponse,
} from "@workspace/api-zod";
import {
  getTeacherStatus,
  requireAdmin,
  requireEducaUser,
} from "../middlewares/educaAuth";
import { getPublicTeachers } from "./public";
import { mapLessonsForDashboard } from "../lib/lesson-data";

const router: IRouter = Router();

router.get(
  "/dashboard/student",
  requireEducaUser,
  async (req, res): Promise<void> => {
    const user = req.educaUser!;
    if (user.role !== "student") {
      res.status(403).json({ error: "Este painel está reservado a estudantes." });
      return;
    }
    const enrollmentRows = await db
      .select({ lessonId: lessonEnrollments.lessonId })
      .from(lessonEnrollments)
      .where(
        and(
          eq(lessonEnrollments.studentId, user.id),
          ne(lessonEnrollments.status, "cancelled"),
        ),
      );
    const lessonIds = enrollmentRows.map((row) => row.lessonId);
    let upcomingLessons: Awaited<ReturnType<typeof mapLessonsForDashboard>> = [];
    let completedLessons = 0;
    let pendingReviews = 0;
    if (lessonIds.length > 0) {
      const enrolledLessons = await db
        .select()
        .from(lessons)
        .where(inArray(lessons.id, lessonIds));
      upcomingLessons = await mapLessonsForDashboard(
        enrolledLessons.filter(
          (lesson) =>
            lesson.status === "scheduled" && lesson.startsAt > new Date(),
        ),
      );
      completedLessons = enrolledLessons.filter(
        (lesson) => lesson.status === "completed",
      ).length;
      const reviewedRows = await db
        .select({ lessonId: lessonReviews.lessonId })
        .from(lessonReviews)
        .where(
          and(
            eq(lessonReviews.studentId, user.id),
            inArray(lessonReviews.lessonId, lessonIds),
          ),
        );
      const reviewed = new Set(reviewedRows.map((row) => row.lessonId));
      pendingReviews = enrolledLessons.filter(
        (lesson) =>
          lesson.status === "completed" && !reviewed.has(lesson.id),
      ).length;
    }
    const teachers = await getPublicTeachers(
      user.interests.length ? { subject: user.interests[0] } : undefined,
    );
    res.json(
      GetStudentDashboardResponse.parse({
        upcomingLessons,
        completedLessons,
        pendingReviews,
        recommendedTeachers: teachers.slice(0, 4),
        interests: user.interests,
      }),
    );
  },
);

router.get(
  "/dashboard/teacher",
  requireEducaUser,
  async (req, res): Promise<void> => {
    const user = req.educaUser!;
    if (user.role !== "teacher") {
      res.status(403).json({ error: "Este painel está reservado a professores aprovados." });
      return;
    }
    const [status, lessonRows, [reviewAggregate]] = await Promise.all([
      getTeacherStatus(user.id),
      db
        .select()
        .from(lessons)
        .where(eq(lessons.teacherId, user.id))
        .orderBy(desc(lessons.startsAt)),
      db
        .select({
          averageRating: avg(lessonReviews.stars),
          reviewCount: count(lessonReviews.id),
        })
        .from(lessonReviews)
        .where(
          and(
            eq(lessonReviews.teacherId, user.id),
            eq(lessonReviews.isVisible, true),
            eq(lessonReviews.isFlagged, false),
          ),
        ),
    ]);
    if (status !== "approved") {
      res.status(403).json({ error: "As funcionalidades de ensino estão bloqueadas." });
      return;
    }
    const upcomingLessons = await mapLessonsForDashboard(
      lessonRows.filter(
        (lesson) => lesson.status === "scheduled" && lesson.startsAt > new Date(),
      ),
    );
    const enrollmentRows =
      lessonRows.length === 0
        ? []
        : await db
            .select({ studentId: lessonEnrollments.studentId })
            .from(lessonEnrollments)
            .where(
              and(
                inArray(
                  lessonEnrollments.lessonId,
                  lessonRows.map((lesson) => lesson.id),
                ),
                ne(lessonEnrollments.status, "cancelled"),
              ),
            );
    res.json(
      GetTeacherDashboardResponse.parse({
        upcomingLessons,
        studentCount: new Set(enrollmentRows.map((row) => row.studentId)).size,
        completedLessons: lessonRows.filter((lesson) => lesson.status === "completed")
          .length,
        averageRating:
          reviewAggregate?.averageRating == null
            ? null
            : Number(reviewAggregate.averageRating),
        reviewCount: Number(reviewAggregate?.reviewCount ?? 0),
        teacherStatus: status,
      }),
    );
  },
);

router.get(
  "/dashboard/admin",
  requireEducaUser,
  requireAdmin,
  async (_req, res): Promise<void> => {
    const [
      [students],
      [approvedTeachers],
      [pendingApplications],
      [scheduledLessons],
      [completedLessons],
      [rating],
      recent,
    ] = await Promise.all([
      db.select({ value: count() }).from(educaUsers).where(eq(educaUsers.role, "student")),
      db
        .select({ value: count() })
        .from(teacherProfiles)
        .innerJoin(educaUsers, eq(educaUsers.id, teacherProfiles.userId))
        .where(
          and(eq(educaUsers.role, "teacher"), eq(teacherProfiles.isActive, true)),
        ),
      db
        .select({ value: count() })
        .from(teacherApplications)
        .where(
          inArray(teacherApplications.status, ["pending", "scheduled", "in_review"]),
        ),
      db.select({ value: count() }).from(lessons).where(eq(lessons.status, "scheduled")),
      db.select({ value: count() }).from(lessons).where(eq(lessons.status, "completed")),
      db
        .select({ value: avg(lessonReviews.stars) })
        .from(lessonReviews)
        .where(
          and(
            eq(lessonReviews.isVisible, true),
            eq(lessonReviews.isFlagged, false),
          ),
        ),
      db
        .select()
        .from(teacherApplications)
        .orderBy(desc(teacherApplications.createdAt))
        .limit(5),
    ]);
    res.json(
      GetAdminDashboardResponse.parse({
        students: Number(students?.value ?? 0),
        approvedTeachers: Number(approvedTeachers?.value ?? 0),
        pendingApplications: Number(pendingApplications?.value ?? 0),
        scheduledLessons: Number(scheduledLessons?.value ?? 0),
        completedLessons: Number(completedLessons?.value ?? 0),
        platformRating: rating?.value == null ? null : Number(rating.value),
        recentApplications: ListTeacherApplicationsResponse.parse(
          recent.map((application) => ({
            id: application.id,
            applicantId: application.applicantId,
            name: application.name,
            email: application.email,
            phone: application.phone,
            identityNumber: null,
            bio: application.bio,
            subjects: application.subjects,
            levels: application.levels,
            experience: application.experience,
            availability: application.availability,
            photoUrl: application.photoUrl,
            status: application.status,
            assessmentScore:
              application.assessmentScore === null
                ? null
                : Number(application.assessmentScore),
            createdAt: application.createdAt,
          })),
        ),
      }),
    );
  },
);

export default router;
