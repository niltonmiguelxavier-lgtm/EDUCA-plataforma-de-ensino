import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, ne, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  auditLogs,
  db,
  demoAssessments,
  educaUsers,
  platformSettings,
  teacherApplications,
  teacherProfiles,
} from "@workspace/db";
import {
  CreateTeacherApplicationBody,
  CreateTeacherApplicationResponse,
  DecideTeacherApplicationBody,
  DecideTeacherApplicationParams,
  DecideTeacherApplicationResponse,
  ListTeacherApplicationsQueryParams,
  ListTeacherApplicationsResponse,
  SubmitDemoAssessmentBody,
  SubmitDemoAssessmentParams,
  SubmitDemoAssessmentResponse,
} from "@workspace/api-zod";
import { requireAdmin, requireEducaUser } from "../middlewares/educaAuth";
import { decryptIdentityNumber, encryptIdentityNumber } from "../lib/pii";

const router: IRouter = Router();

function toApplication(
  application: typeof teacherApplications.$inferSelect,
  includeIdentityNumber: boolean,
) {
  return {
    id: application.id,
    applicantId: application.applicantId,
    name: application.name,
    email: application.email,
    phone: application.phone,
    identityNumber: includeIdentityNumber
      ? decryptIdentityNumber(application.identityNumberEncrypted)
      : null,
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
  };
}

async function writeAudit(
  actorId: string,
  action: string,
  applicationId: string,
  details: Record<string, unknown>,
) {
  await db.insert(auditLogs).values({
    id: randomUUID(),
    actorId,
    action,
    entityType: "teacher_application",
    entityId: applicationId,
    details,
  });
}

router.post(
  "/teacher-applications",
  requireEducaUser,
  async (req, res): Promise<void> => {
    const parsed = CreateTeacherApplicationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const user = req.educaUser!;
    if (user.role === "admin") {
      res.status(403).json({ error: "Uma conta de administração não pode candidatar-se." });
      return;
    }

    const [activeApplication] = await db
      .select({ id: teacherApplications.id })
      .from(teacherApplications)
      .where(
        and(
          eq(teacherApplications.applicantId, user.id),
          ne(teacherApplications.status, "rejected"),
        ),
      )
      .limit(1);
    if (activeApplication) {
      res.status(409).json({ error: "Já existe uma candidatura em avaliação." });
      return;
    }

    const id = randomUUID();
    const [application] = await db
      .insert(teacherApplications)
      .values({
        id,
        applicantId: user.id,
        name: parsed.data.name,
        email: user.email,
        phone: parsed.data.phone,
        identityNumberEncrypted: encryptIdentityNumber(parsed.data.identityNumber),
        bio: parsed.data.bio,
        subjects: parsed.data.subjects,
        levels: parsed.data.levels,
        experience: parsed.data.experience ?? null,
        availability: parsed.data.availability ?? null,
        photoUrl: parsed.data.photoUrl ?? null,
      })
      .returning();
    await db
      .update(educaUsers)
      .set({ name: parsed.data.name, phone: parsed.data.phone })
      .where(eq(educaUsers.id, user.id));
    await writeAudit(user.id, "teacher_application_submitted", id, {
      status: "pending",
    });
    res
      .status(201)
      .json(CreateTeacherApplicationResponse.parse(toApplication(application, false)));
  },
);

router.get(
  "/admin/teacher-applications",
  requireEducaUser,
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = ListTeacherApplicationsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const filters = [];
    if (parsed.data.status) {
      filters.push(eq(teacherApplications.status, parsed.data.status));
    }
    if (parsed.data.query?.trim()) {
      const term = `%${parsed.data.query.trim()}%`;
      filters.push(
        or(
          ilike(teacherApplications.name, term),
          ilike(teacherApplications.email, term),
          ilike(teacherApplications.phone, term),
        )!,
      );
    }
    const applications = await db
      .select()
      .from(teacherApplications)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(teacherApplications.createdAt));
    res.json(
      ListTeacherApplicationsResponse.parse(
        applications.map((application) => toApplication(application, true)),
      ),
    );
  },
);

router.post(
  "/admin/teacher-applications/:applicationId/assessment",
  requireEducaUser,
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = SubmitDemoAssessmentParams.safeParse(req.params);
    const parsed = SubmitDemoAssessmentBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [application] = await db
      .select()
      .from(teacherApplications)
      .where(eq(teacherApplications.id, params.data.applicationId))
      .limit(1);
    if (!application) {
      res.status(404).json({ error: "Candidatura não encontrada." });
      return;
    }
    if (application.status !== "scheduled" && application.status !== "in_review") {
      res.status(409).json({
        error: "Agende a aula de demonstração antes de registar a avaliação.",
      });
      return;
    }
    const scores = parsed.data;
    const totalScore =
      scores.subjectMastery +
      scores.clarity +
      scores.organization +
      scores.questionHandling +
      scores.communication;
    const percentage = (totalScore / 25) * 100;
    const assessmentId = randomUUID();
    const [assessment] = await db
      .insert(demoAssessments)
      .values({
        id: assessmentId,
        applicationId: application.id,
        evaluatorId: req.educaUser!.id,
        subjectMastery: scores.subjectMastery,
        clarity: scores.clarity,
        organization: scores.organization,
        questionHandling: scores.questionHandling,
        communication: scores.communication,
        totalScore,
        percentage: percentage.toFixed(2),
        notes: scores.notes ?? null,
      })
      .returning();
    await db
      .update(teacherApplications)
      .set({ status: "in_review", assessmentScore: percentage.toFixed(2) })
      .where(eq(teacherApplications.id, application.id));
    await writeAudit(req.educaUser!.id, "teacher_demo_assessed", application.id, {
      assessmentId,
      totalScore,
      percentage,
    });
    res.status(201).json(
      SubmitDemoAssessmentResponse.parse({
        subjectMastery: assessment.subjectMastery,
        clarity: assessment.clarity,
        organization: assessment.organization,
        questionHandling: assessment.questionHandling,
        communication: assessment.communication,
        notes: assessment.notes,
        id: assessment.id,
        applicationId: assessment.applicationId,
        evaluatorId: assessment.evaluatorId,
        totalScore: assessment.totalScore,
        percentage: Number(assessment.percentage),
        createdAt: assessment.createdAt,
      }),
    );
  },
);

router.post(
  "/admin/teacher-applications/:applicationId/decision",
  requireEducaUser,
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = DecideTeacherApplicationParams.safeParse(req.params);
    const parsed = DecideTeacherApplicationBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [application] = await db
      .select()
      .from(teacherApplications)
      .where(eq(teacherApplications.id, params.data.applicationId))
      .limit(1);
    if (!application) {
      res.status(404).json({ error: "Candidatura não encontrada." });
      return;
    }

    const decision = parsed.data.decision;
    const notes = parsed.data.notes ?? null;
    let status = application.status;
    let scheduledAt = application.scheduledAt;
    if (decision === "schedule_assessment") {
      if (!parsed.data.scheduledAt || new Date(parsed.data.scheduledAt) <= new Date()) {
        res.status(400).json({ error: "Indique uma data futura para a avaliação." });
        return;
      }
      status = "scheduled";
      scheduledAt = new Date(parsed.data.scheduledAt);
    } else if (decision === "begin_review") {
      status = "in_review";
    } else if (decision === "request_new_assessment") {
      status = "pending";
    } else if (decision === "approve") {
      const [setting] = await db
        .select()
        .from(platformSettings)
        .where(eq(platformSettings.key, "minimum_demo_score"))
        .limit(1);
      const settingValue =
        setting?.value &&
        typeof setting.value === "object" &&
        "percentage" in setting.value
          ? Number(setting.value.percentage)
          : 70;
      const minimum = Number.isFinite(settingValue) ? settingValue : 70;
      if (
        application.assessmentScore === null ||
        Number(application.assessmentScore) < minimum
      ) {
        res.status(409).json({
          error: `A candidatura ainda não cumpre a pontuação mínima de ${minimum}%.`,
        });
        return;
      }
      status = "approved";
    } else if (decision === "reject") {
      status = "rejected";
    } else if (decision === "suspend") {
      if (application.status !== "approved") {
        res.status(409).json({
          error: "Só é possível suspender um professor aprovado.",
        });
        return;
      }
      status = "suspended";
    }

    await db.transaction(async (tx) => {
      await tx
        .update(teacherApplications)
        .set({
          status,
          scheduledAt,
          decisionNotes: notes,
        })
        .where(eq(teacherApplications.id, application.id));

      if (decision === "approve") {
        await tx
          .update(educaUsers)
          .set({ role: "teacher", name: application.name, phone: application.phone })
          .where(eq(educaUsers.id, application.applicantId));
        await tx
          .insert(teacherProfiles)
          .values({
            userId: application.applicantId,
            bio: application.bio,
            photoUrl: application.photoUrl,
            subjects: application.subjects,
            levels: application.levels,
            availability: application.availability,
            isActive: true,
          })
          .onConflictDoUpdate({
            target: teacherProfiles.userId,
            set: {
              bio: application.bio,
              photoUrl: application.photoUrl,
              subjects: application.subjects,
              levels: application.levels,
              availability: application.availability,
              isActive: true,
            },
          });
      }
      if (decision === "suspend") {
        await tx
          .update(teacherProfiles)
          .set({ isActive: false })
          .where(eq(teacherProfiles.userId, application.applicantId));
      }
      if (decision === "reject") {
        await tx
          .update(teacherProfiles)
          .set({ isActive: false })
          .where(eq(teacherProfiles.userId, application.applicantId));
      }
      await tx.insert(auditLogs).values({
        id: randomUUID(),
        actorId: req.educaUser!.id,
        action: `teacher_application_${decision}`,
        entityType: "teacher_application",
        entityId: application.id,
        details: {
          previousStatus: application.status,
          status,
          assessmentScore:
            application.assessmentScore === null
              ? null
              : Number(application.assessmentScore),
          scheduledAt: scheduledAt?.toISOString() ?? null,
          hasNotes: Boolean(notes),
        },
      });
    });

    const [updated] = await db
      .select()
      .from(teacherApplications)
      .where(eq(teacherApplications.id, application.id))
      .limit(1);
    res.json(
      DecideTeacherApplicationResponse.parse(toApplication(updated, true)),
    );
  },
);

export default router;
