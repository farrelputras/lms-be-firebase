import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {
  adminAuth, adminDb, normalizeFirestoreData,
} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {requireRole} from "../middleware/requireRole.js";
import {resolveChatbotEnabled} from "../utils/chatbotAccess.js";
import {success, error} from "../utils/response.js";

const router = Router();

// All user-management routes require admin
router.use(verifyToken, requireRole("admin"));

// GET /users — list all users with optional filters
router.get("/", async (req, res) => {
  try {
    const {role, search} = req.query as {
      role?: string;
      search?: string;
    };

    let query: FirebaseFirestore.Query = adminDb.collection("users");
    if (role) {
      query = query.where("role", "==", role);
    }

    const snapshot = await query.get();
    let users: Array<Record<string, unknown>> = snapshot.docs.map(
      (docSnap) => {
        const data = normalizeFirestoreData(
          docSnap.data()
        ) as Record<string, unknown>;
        return {
          uid: docSnap.id,
          ...data,
          chatbotEnabled: resolveChatbotEnabled(data.role as string | undefined, data.chatbotEnabled),
        };
      }
    );

    if (search) {
      const s = search.toLowerCase();
      users = users.filter((u) => {
        const n = String(u["name"] || "").toLowerCase();
        const e = String(u["email"] || "").toLowerCase();
        return n.includes(s) || e.includes(s);
      });
    }

    res.json(success(users));
  } catch {
    res.status(500).json(error("FETCH_FAILED", "Failed to fetch users"));
  }
});

// GET /users/:uid
router.get("/:uid", async (req, res) => {
  try {
    const {uid} = req.params;
    const docSnap = await adminDb.collection("users").doc(uid).get();

    if (!docSnap.exists) {
      res.status(404).json(error("NOT_FOUND", "User not found"));
      return;
    }

    const data = normalizeFirestoreData(docSnap.data()) as Record<string, unknown>;
    res.json(success({
      uid: docSnap.id,
      ...data,
      chatbotEnabled: resolveChatbotEnabled(data.role as string | undefined, data.chatbotEnabled),
    }));
  } catch {
    res.status(500).json(error("FETCH_FAILED", "Failed to fetch user"));
  }
});

// PATCH /users/:uid
router.patch("/:uid", async (req, res) => {
  try {
    const {uid} = req.params;
    const {name, email, totalPoints, chatbotEnabled} = req.body as {
      name?: string;
      email?: string;
      totalPoints?: number;
      chatbotEnabled?: boolean;
    };

    const updates: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;
    if (totalPoints !== undefined) updates.totalPoints = totalPoints;
    if (chatbotEnabled !== undefined) {
      if (typeof chatbotEnabled !== "boolean") {
        res.status(400).json(error("BAD_REQUEST", "chatbotEnabled must be a boolean"));
        return;
      }
      updates.chatbotEnabled = chatbotEnabled;
    }

    await adminDb.collection("users").doc(uid).update(updates);

    if (email) await adminAuth.updateUser(uid, {email});
    if (name) await adminAuth.updateUser(uid, {displayName: name});

    const updated = await adminDb.collection("users").doc(uid).get();
    const updatedData = normalizeFirestoreData(updated.data()) as Record<string, unknown>;
    res.json(success({
      uid: updated.id,
      ...updatedData,
      chatbotEnabled: resolveChatbotEnabled(updatedData.role as string | undefined, updatedData.chatbotEnabled),
    }));
  } catch {
    res.status(500).json(
      error("UPDATE_FAILED", "Failed to update user")
    );
  }
});

// DELETE /users/:uid — hard-delete from Auth + cascade Firestore cleanup
router.delete("/:uid", async (req, res) => {
  const {uid} = req.params;
  try {
    await adminAuth.deleteUser(uid);

    const COLLECTIONS = [
      "enrollments",
      "progress",
      "quiz_results",
      "activity_progress",
      "certificates",
    ];

    const refs: FirebaseFirestore.DocumentReference[] = [
      adminDb.collection("users").doc(uid),
    ];

    for (const col of COLLECTIONS) {
      const snap = await adminDb
        .collection(col)
        .where("userId", "==", uid)
        .get();
      snap.docs.forEach((d) => refs.push(d.ref));
    }

    const CHUNK = 499;
    for (let i = 0; i < refs.length; i += CHUNK) {
      const batch = adminDb.batch();
      refs.slice(i, i + CHUNK).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }

    res.json(success({uid}));
  } catch (err) {
    console.error("[DELETE user]", uid, err);
    res.status(500).json(error("DELETE_FAILED", "Failed to delete user"));
  }
});

// POST /users/upsert — backward-compatible upsert
router.post("/upsert", async (req, res) => {
  const {uid, email, displayName} = req.body as {
    uid?: string;
    email?: string;
    displayName?: string;
  };

  if (!uid || !email) {
    res.status(400).json(
      error("BAD_REQUEST", "uid and email are required")
    );
    return;
  }

  try {
    const userRef = adminDb.collection("users").doc(uid);
    const existing = await userRef.get();

    if (!existing.exists) {
      await userRef.set({
        uid,
        email,
        name: displayName || email.split("@")[0],
        role: "student",
        totalPoints: 0,
        isActive: true,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      await userRef.set(
        {
          email,
          name: displayName || existing.data()?.name || "",
          updatedAt: FieldValue.serverTimestamp(),
        },
        {merge: true}
      );
    }

    const latest = await userRef.get();
    res.json(success({
      uid: latest.id,
      ...(normalizeFirestoreData(latest.data()) as Record<string, unknown>),
    }));
  } catch {
    res.status(500).json(
      error("UPSERT_FAILED", "Failed to upsert user profile")
    );
  }
});

export default router;
