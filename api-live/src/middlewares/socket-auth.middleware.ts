// ─────────────────────────────────────────────
//  middlewares/socket-auth.middleware.ts
//  Socket.IO middleware – Firebase JWT verification
// ─────────────────────────────────────────────
import { Socket } from "socket.io";
import * as admin from "firebase-admin/auth";
import { UnauthorizedError } from "@/lib/errors";
import { logger } from "@/lib/logger";

// Extend the Socket type so downstream handlers can access the verified user
declare module "socket.io" {
  interface Socket {
    user?: {
      uid: string;
      email?: string;
      phone_number?: string;
      name?: string;
      picture?: string;
    };
  }
}

// ⚠️ DEV/TEST ONLY. When ALLOW_UID_AUTH=true, the server trusts a raw user UID
// sent by the client instead of verifying a Firebase ID token. This DISABLES
// authentication — anyone can act as any user — and must never be enabled in
// production. It exists so the playgrounds / test-live app can be driven with a
// bare UID during local testing of the Live features.
// Read at request time (not module load) so env load order can't matter.
const uidAuthEnabled = () => process.env.ALLOW_UID_AUTH === "true";

/**
 * Socket.IO middleware. In normal mode it verifies a Firebase JWT token; in
 * dev UID mode (ALLOW_UID_AUTH=true) it trusts a raw UID instead.
 *
 * The client sends the credential via one of:
 *  - `auth.uid` / `auth.token` in the handshake auth object
 *  - `uid` / `token` query parameter in the connection URL
 *
 * On success the user payload is attached to `socket.user`.
 */
export async function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void
): Promise<void> {
  try {
    const auth = socket.handshake.auth ?? {};
    const query = socket.handshake.query ?? {};

    // ── DEV UID MODE: trust the provided UID, no Firebase verification ──
    if (uidAuthEnabled()) {
      const uid =
        (auth.uid as string | undefined) ??
        (auth.token as string | undefined) ??
        (query.uid as string | undefined) ??
        (query.token as string | undefined);

      if (!uid) {
        return next(new UnauthorizedError("Authentication required: no uid provided"));
      }

      logger.warn("Socket auth: DEV UID mode (token verification bypassed)", {
        socketId: socket.id,
        uid,
      });
      socket.user = { uid };
      return next();
    }

    // 1. Extract token from handshake auth or query string
    const token =
      (auth.token as string | undefined) ?? (query.token as string | undefined);



    if (!token) {
      logger.warn("Socket auth rejected: no token provided", {
        socketId: socket.id,
      });
      return next(new UnauthorizedError("Authentication required: no token provided"));
    }

    // 2. Verify the Firebase ID token
    const decoded = await admin.getAuth().verifyIdToken(token);



    // 3. Attach verified user to the socket
    socket.user = {
      uid: decoded.uid,
      email: decoded.email,
      phone_number: decoded.firebase?.phone_number,
      name: decoded.name,
      picture: decoded.picture,
    };

    // logger.info("Socket authenticated", {
    //   socketId: socket.id,
    //   uid: decoded.uid,
    // });

    next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Socket auth failed", { socketId: socket.id, message });
    next(new UnauthorizedError(`Authentication failed: ${message}`));
  }
}
