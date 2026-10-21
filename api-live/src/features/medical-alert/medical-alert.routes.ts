import { Router } from "express";
import { authMiddleware } from "@middlewares/auth.middleware";
import validate from "@middlewares/validator.middleware";
import { asyncHandler } from "@middlewares/error-handler.middleware";
import { MedicalAlertSchema } from "@features/medical-alert/medical-alert.schema";
import { handleMedicalAlert } from "@features/medical-alert/medical-alert.service";
import { logger } from "@/lib/logger";

const router = Router();

/**
 * POST /api/medical-alert/send
 *
 * Sends an emergency SMS alert with a Google Maps link to all
 * emergency contacts configured for the authenticated user.
 *
 * Body:
 *   latitude  – GPS latitude  (-90 to 90)
 *   longitude – GPS longitude (-180 to 180)
 *
 * Headers:
 *   Authorization: Bearer <Firebase ID token>
 */
router.post(
  "/send",
  authMiddleware,
  validate(MedicalAlertSchema),
  asyncHandler(async (req, res) => {
    const { latitude, longitude } = req.validated!.body as {
      latitude: number;
      longitude: number;
    };

    const userId = req.user!.uid;

    logger.info("Medical alert requested", {
      userId,
      latitude,
      longitude,
    });

    const result = await handleMedicalAlert(userId, latitude, longitude);

    res.json({
      status: "success",
      data: result,
    });
  })
);

export default router;