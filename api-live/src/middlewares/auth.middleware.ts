// ─────────────────────────────────────────────
//  middlewares/auth.middleware.ts
//  Express middleware – Firebase JWT verification
// ─────────────────────────────────────────────
import { Request, Response, NextFunction } from "express";
import * as admin from "firebase-admin/auth";
import { UnauthorizedError } from "@/lib/errors";
import { logger } from "@/lib/logger";

// ⚠️ DEV/TEST ONLY — see socket-auth.middleware.ts. When ALLOW_UID_AUTH=true the
// server trusts a raw UID instead of verifying a Firebase token. Never enable in
// production. Read at request time so env load order can't matter.
const uidAuthEnabled = () => process.env.ALLOW_UID_AUTH === "true";

/**
 * Express middleware. Normal mode verifies a Firebase JWT from the
 * `Authorization: Bearer <token>` header; dev UID mode (ALLOW_UID_AUTH=true)
 * trusts a raw UID from the `X-User-Id` header (or the Bearer value).
 *
 * On success the user payload is attached to `req.user`.
 */
export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    // ── DEV UID MODE: trust the provided UID, no Firebase verification ──
    if (uidAuthEnabled()) {
      const headerUid = req.headers["x-user-id"];
      const uid =
        (Array.isArray(headerUid) ? headerUid[0] : headerUid) ||
        (authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1].trim() : undefined);

      if (!uid) {
        return next(new UnauthorizedError("Authentication required: no uid provided"));
      }

      logger.warn("Auth: DEV UID mode (token verification bypassed)", {
        path: req.path,
        uid,
      });
      req.user = { uid, email: null, name: null, picture: null };
      return next();
    }

    // 1. Extract token from Authorization header
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logger.warn("Auth rejected: no Bearer token provided", {
        path: req.path,
        method: req.method,
      });
      return next(new UnauthorizedError("Authentication required: no token provided"));
    }

    const token = authHeader.split(" ")[1].trim();


    // 2. Verify the Firebase ID token
    const decoded = await admin.getAuth().verifyIdToken(token);

    // 3. Attach verified user to the request
    req.user = {
      uid: decoded.uid,
      email: decoded.email ?? null,
      name: decoded.name ?? null,
      picture: decoded.picture ?? null,
    };

    logger.debug("Request authenticated", {
      uid: decoded.uid,
      path: req.path,
    });

    next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Auth failed", { path: req.path, message });
    next(new UnauthorizedError(`Authentication failed: ${message}`));
  }
}