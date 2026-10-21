// ─────────────────────────────────────────────
//  features/assistant/prescription.routes.ts
//
//  REST API backing the caregiver web portal (served at /portal). Lets a
//  caregiver / medical professional manage a patient's prescriptions and
//  intake log for a given user id.
//
//  Auth: authMiddleware. In demo mode (ALLOW_UID_AUTH=true) the portal passes
//  the patient's uid via the `X-User-Id` header and no Firebase token is
//  required; in production the same routes work with a Bearer ID token.
//
//  Routes (mounted at /api/prescriptions):
//    GET    /                 list all prescriptions
//    POST   /                 create a prescription
//    PATCH  /:id              update selected fields
//    DELETE /:id              delete a prescription
//    GET    /today?date=      day schedule w/ taken/upcoming/missed per slot
//    POST   /:id/taken        mark (or undo) a dose taken
// ─────────────────────────────────────────────
import { Router } from "express";
import { authMiddleware } from "@middlewares/auth.middleware";
import validate from "@middlewares/validator.middleware";
import { asyncHandler } from "@middlewares/error-handler.middleware";
import {
  CreatePrescriptionSchema,
  UpdatePrescriptionSchema,
  DeletePrescriptionSchema,
  MarkTakenSchema,
  TodayScheduleSchema,
} from "@features/assistant/prescription.schema";
import {
  listPrescriptions,
  createPrescription,
  updatePrescription,
  deletePrescription,
  getDaySchedule,
} from "@features/assistant/prescription.service";
import { markMedicationTaken } from "@features/assistant/prescription.tools";
import { BadRequestError } from "@/lib/errors";
import {
  PrescriptionFields,
  TimeSlot,
} from "@/types/assistant";

const router = Router();

// All portal routes require an authenticated (or dev-UID) caller.
router.use(authMiddleware);

// ── List ──────────────────────────────────────
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const data = await listPrescriptions(req.user!.uid);
    res.json({ status: "success", data });
  })
);

// ── Today's schedule ──────────────────────────
router.get(
  "/today",
  validate(TodayScheduleSchema),
  asyncHandler(async (req, res) => {
    const { date } = req.validated!.query as { date?: string };
    const data = await getDaySchedule(req.user!.uid, date);
    res.json({ status: "success", data });
  })
);

// ── Create ────────────────────────────────────
router.post(
  "/",
  validate(CreatePrescriptionSchema),
  asyncHandler(async (req, res) => {
    const fields = req.validated!.body as PrescriptionFields;
    const data = await createPrescription(req.user!.uid, fields);
    res.status(201).json({ status: "success", data });
  })
);

// ── Update ────────────────────────────────────
router.patch(
  "/:id",
  validate(UpdatePrescriptionSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.validated!.params as { id: string };
    const fields = req.validated!.body as Partial<PrescriptionFields>;
    const data = await updatePrescription({
      userId: req.user!.uid,
      prescriptionId: id,
      fields,
    });
    res.json({ status: "success", data });
  })
);

// ── Delete ────────────────────────────────────
router.delete(
  "/:id",
  validate(DeletePrescriptionSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.validated!.params as { id: string };
    await deletePrescription({ userId: req.user!.uid, prescriptionId: id });
    res.json({ status: "success", data: { id } });
  })
);

// ── Mark taken / undo ─────────────────────────
router.post(
  "/:id/taken",
  validate(MarkTakenSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.validated!.params as { id: string };
    const { slot, date, taken } = req.validated!.body as {
      slot: TimeSlot;
      date?: string;
      taken?: boolean;
    };

    const result = await markMedicationTaken({
      userId: req.user!.uid,
      prescriptionId: id,
      slot,
      date,
      taken,
    });

    if (!result.success) {
      // Business-rule rejection (e.g. slot not scheduled) → 400.
      throw new BadRequestError(result.error ?? "Could not update intake");
    }

    res.json({ status: "success", data: result.data });
  })
);

export default router;
