import {Request, Response, NextFunction} from "express";

import {adminAuth, adminDb} from "../firebaseAdmin.js";

/**
 * Helper: get the user's role.
 *
 * 1. First, check if the Firebase Auth token already has a `role`
 *    custom claim (set via adminAuth.setCustomUserClaims).
 *    This is the fastest path — no database read needed.
 *
 * 2. If no custom claim exists, fall back to reading the `role`
 *    field from the Firestore `users/{uid}` document.
 *    This costs one Firestore read per request, but lets you
 *    manage roles directly in Firestore without needing to
 *    sync custom claims every time.
 *
 * 3. If neither exists, default to "student".
 *
 * @param {string} uid - The Firebase Auth user ID.
 * @param {string} [tokenRole] - The role from the token's custom claims.
 * @return {Promise<string>} The resolved role string.
 */
const resolveRole = async (
  uid: string,
  tokenRole?: string
): Promise<string> => {
  // If the token already carries a role claim, use it directly.
  // This avoids an extra Firestore read.
  if (tokenRole) {
    return tokenRole;
  }

  // No role in the token — look it up in Firestore.
  try {
    const userDoc = await adminDb.collection("users").doc(uid).get();
    if (userDoc.exists) {
      const firestoreRole = userDoc.data()?.role as string | undefined;
      if (firestoreRole) {
        return firestoreRole;
      }
    }
  } catch {
    // If Firestore read fails, fall through to default.
    // This prevents a database error from blocking authentication entirely.
  }

  // Ultimate fallback — treat the user as a student.
  return "student";
};

/**
 * verifyToken — required auth middleware.
 *
 * Validates the Firebase ID token from the Authorization header.
 * If valid, attaches `req.user` with uid, email, and role,
 * then calls next(). Otherwise responds with 401.
 *
 * @param {Request} req - Express request object.
 * @param {Response} res - Express response object.
 * @param {NextFunction} next - Express next middleware function.
 * @return {Promise<void>}
 */
export const verifyToken = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const header = req.headers.authorization;

  // The header must exist and follow the "Bearer <token>" format.
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({
      success: false,
      error: {code: "UNAUTHORIZED", message: "Missing or invalid token"},
    });
    return;
  }

  try {
    // Extract the JWT string after "Bearer ".
    const token = header.split("Bearer ")[1];

    // Verify the token with Firebase Admin SDK.
    // This checks signature, expiration, and issuer.
    const decoded = await adminAuth.verifyIdToken(token);

    // Resolve the role: custom claim first, then Firestore fallback.
    const role = await resolveRole(
      decoded.uid,
      decoded.role as string | undefined
    );

    // Attach the authenticated user info to the request object
    // so downstream route handlers and middleware can access it.
    req.user = {
      uid: decoded.uid,
      email: decoded.email || "",
      role,
    };

    next();
  } catch {
    res.status(401).json({
      success: false,
      error: {code: "UNAUTHORIZED", message: "Invalid or expired token"},
    });
  }
};

/**
 * optionalAuth — optional auth middleware.
 *
 * Same as verifyToken, but does NOT block the request if
 * the token is missing or invalid. Used for public endpoints
 * that behave differently for logged-in users (e.g., admins
 * see unpublished courses).
 *
 * @param {Request} req - Express request object.
 * @param {Response} _res - Express response object (unused).
 * @param {NextFunction} next - Express next middleware function.
 * @return {Promise<void>}
 */
export const optionalAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  const header = req.headers.authorization;

  if (header?.startsWith("Bearer ")) {
    try {
      const token = header.split("Bearer ")[1];
      const decoded = await adminAuth.verifyIdToken(token);

      // Same role resolution logic as verifyToken.
      const role = await resolveRole(
        decoded.uid,
        decoded.role as string | undefined
      );

      req.user = {
        uid: decoded.uid,
        email: decoded.email || "",
        role,
      };
    } catch {
      // Token was provided but invalid — proceed without auth.
      // The request continues as an unauthenticated/public request.
    }
  }

  // Always call next(), whether auth succeeded or not.
  next();
};
