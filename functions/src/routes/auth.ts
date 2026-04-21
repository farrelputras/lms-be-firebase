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

    const profile = normalizeFirestoreData(
      docSnap.data()
    ) as Record<string, unknown>;

    res.json(success({
      uid: docSnap.id,
      ...profile,
      totalPoints: profile.totalPoints === undefined ?
        0 :
        profile.totalPoints,
      badges: profile.badges === undefined ? [] : profile.badges,
    }));
  } catch (err: any) {
  // JSON.stringify ensures the error isn't hidden in the cloud logs
  console.error("🔴 AUTH_ME_ERROR:", JSON.stringify({
    message: err.message,
    stack: err.stack
  }));
  res.status(500).json(error("FETCH_FAILED", err.message || "Unknown error"));
}
});

// POST /auth/sync — Bridges Client-Side Auth with Server-Side Firestore
router.post("/sync", verifyToken, async (req, res) => {
  try {
    const uid = req.user!.uid;
    const email = req.user!.email || req.body.email; 
    const displayName = req.body.displayName || email?.split("@")[0] || "User";

    const userRef = adminDb.collection("users").doc(uid);
    let docSnap = await userRef.get();

    // 1. Create user if they don't exist
    if (!docSnap.exists) {
      const newUser = {
        name: displayName,
        email: email,
        role: "student", // Default for new signups
        totalPoints: 0,
        isActive: true,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      await userRef.set(newUser);
      
      // Refresh the snapshot so we can use it in Step 2
      docSnap = await userRef.get();
    }

    // 2. SOURCE OF TRUTH: Get the actual role from Firestore
    const userData = docSnap.data();
    const currentRole = userData?.role || "student";

    // 3. PASSPORT UPDATE: Always sync Firestore role to Firebase Auth Claims
    // This ensures that if you manually change a role in Firestore, 
    // the user gets the permission on their next sync/login.
    await adminAuth.setCustomUserClaims(uid, { role: currentRole });

    res.status(201).json(success({ 
      message: "User synced successfully", 
      uid: uid,
      role: currentRole // Useful for the Flutter side to know
    }));
  } catch (err: unknown) {
    console.error("Sync Error:", err);
    res.status(500).json(error("SYNC_FAILED", "Failed to sync user profile"));
  }
});

export default router;
