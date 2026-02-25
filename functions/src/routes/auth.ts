import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {adminAuth, adminDb, normalizeFirestoreData} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {requireRole} from "../middleware/requireRole.js";
import {success, error} from "../utils/response.js";

const router = Router();

// POST /auth/register
router.post("/register", async (req, res) => {
  const {name, email, password} = req.body as {
    name?: string;
    email?: string;
    password?: string;
  };

  if (!email || !password) {
    res.status(400).json(
      error("BAD_REQUEST", "email and password are required")
    );
    return;
  }

  try {
    const displayName = name || email.split("@")[0];
    const userRecord = await adminAuth.createUser({
      email,
      password,
      displayName,
    });

    await adminAuth.setCustomUserClaims(userRecord.uid, {role: "student"});

    await adminDb.collection("users").doc(userRecord.uid).set({
      name: displayName,
      email,
      role: "student",
      totalPoints: 0,
      isActive: true,
      createdAt: FieldValue.serverTimestamp(),
    });

    res.status(201).json(success({
      uid: userRecord.uid,
      email: userRecord.email,
      name: displayName,
      role: "student",
    }));
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Failed to register user";
    res.status(500).json(error("REGISTER_FAILED", msg));
  }
});

// POST /auth/assign-role — admin only
router.post(
  "/assign-role",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    const {uid, role} = req.body as {uid?: string; role?: string};

    if (!uid || !role) {
      res.status(400).json(
        error("BAD_REQUEST", "uid and role are required")
      );
      return;
    }

    const validRoles = ["student", "admin", "instructor"];
    if (!validRoles.includes(role)) {
      res.status(400).json(
        error("BAD_REQUEST",
          `Invalid role. Must be one of: ${validRoles.join(", ")}`)
      );
      return;
    }

    try {
      await adminAuth.setCustomUserClaims(uid, {role});
      await adminDb.collection("users").doc(uid).set(
        {role, updatedAt: FieldValue.serverTimestamp()},
        {merge: true}
      );

      res.json(success({uid, role}));
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to assign role";
      res.status(500).json(error("ASSIGN_ROLE_FAILED", msg));
    }
  }
);

// GET /auth/me
router.get("/me", verifyToken, async (req, res) => {
  try {
    const uid = req.user!.uid;
    const docSnap = await adminDb.collection("users").doc(uid).get();

    if (!docSnap.exists) {
      res.status(404).json(
        error("NOT_FOUND", "User profile not found")
      );
      return;
    }

    res.json(success({
      uid: docSnap.id,
      ...(normalizeFirestoreData(docSnap.data()) as Record<string, unknown>),
    }));
  } catch {
    res.status(500).json(
      error("FETCH_FAILED", "Failed to fetch user profile")
    );
  }
});

export default router;
