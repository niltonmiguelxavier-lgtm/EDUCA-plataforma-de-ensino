import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db, educaUsers, teacherApplications } from "@workspace/db";
import {
  GetMyProfileResponse,
  GetMyTeacherApplicationResponse,
  UpdateMyProfileBody,
  UpdateMyProfileResponse,
} from "@workspace/api-zod";
import { requireEducaUser } from "../middlewares/educaAuth";

const router: IRouter = Router();

function profileResponse(
  user: typeof educaUsers.$inferSelect,
  teacherStatus: typeof teacherApplications.$inferSelect.status | null,
) {
  return GetMyProfileResponse.parse({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    teacherStatus,
    phone: user.phone,
    level: user.level,
    interests: user.interests,
  });
}

router.get("/me", requireEducaUser, async (req, res): Promise<void> => {
  const user = req.educaUser!;
  const [application] = await db
    .select({ status: teacherApplications.status })
    .from(teacherApplications)
    .where(eq(teacherApplications.applicantId, user.id))
    .orderBy(desc(teacherApplications.createdAt))
    .limit(1);
  res.json(profileResponse(user, application?.status ?? null));
});

router.patch("/me", requireEducaUser, async (req, res): Promise<void> => {
  const parsed = UpdateMyProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [updated] = await db
    .update(educaUsers)
    .set(parsed.data)
    .where(eq(educaUsers.id, req.educaUser!.id))
    .returning();
  const [application] = await db
    .select({ status: teacherApplications.status })
    .from(teacherApplications)
    .where(eq(teacherApplications.applicantId, updated.id))
    .orderBy(desc(teacherApplications.createdAt))
    .limit(1);
  res.json(UpdateMyProfileResponse.parse(profileResponse(updated, application?.status ?? null)));
});

router.get(
  "/teacher-applications",
  requireEducaUser,
  async (req, res): Promise<void> => {
    const [application] = await db
      .select()
      .from(teacherApplications)
      .where(eq(teacherApplications.applicantId, req.educaUser!.id))
      .orderBy(desc(teacherApplications.createdAt))
      .limit(1);
    res.json(
      GetMyTeacherApplicationResponse.parse(
        application
          ? {
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
            }
          : null,
      ),
    );
  },
);

export default router;
