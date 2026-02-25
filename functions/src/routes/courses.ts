import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {
  adminDb, mapDoc, normalizeFirestoreData,
} from "../firebaseAdmin.js";
import {optionalAuth, verifyToken} from "../middleware/verifyToken.js";

import {requireRole} from "../middleware/requireRole.js";
import {success, error} from "../utils/response.js";

const router = Router();

// GET /courses — public (admins see all, others see published only)
router.get("/", optionalAuth, async (req, res) => {
  try {
    let query: FirebaseFirestore.Query = adminDb.collection("courses");
    if (req.user?.role !== "admin") {
      query = query.where("isPublished", "==", true);
    }

    const snapshot = await query.get();
    const courses = snapshot.docs.map((docSnap) => mapDoc(docSnap));
    res.json(success(courses));
  } catch {
    res.status(500).json(
      error("FETCH_FAILED", "Failed to fetch courses")
    );
  }
});

// GET /courses/:courseId — public
router.get("/:courseId", async (req, res) => {
  try {
    const {courseId} = req.params;
    const docSnap = await adminDb.collection("courses").doc(courseId).get();

    if (!docSnap.exists) {
      res.status(404).json(error("NOT_FOUND", "Course not found"));
      return;
    }

    res.json(success({
      id: docSnap.id,
      ...(normalizeFirestoreData(docSnap.data()) as Record<string, unknown>),
    }));
  } catch {
    res.status(500).json(
      error("FETCH_FAILED", "Failed to fetch course")
    );
  }
});

// POST /courses — admin only
router.post(
  "/",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const {title, description, thumbnailUrl, isPublished} = req.body as {
        title?: string;
        description?: string;
        thumbnailUrl?: string;
        isPublished?: boolean;
      };

      if (!title) {
        res.status(400).json(
          error("BAD_REQUEST", "title is required")
        );
        return;
      }

      const courseData = {
        title,
        description: description || "",
        thumbnailUrl: thumbnailUrl || "",
        isPublished: isPublished ?? false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      const docRef = await adminDb.collection("courses").add(courseData);
      res.status(201).json(success({id: docRef.id, ...courseData}));
    } catch {
      res.status(500).json(
        error("CREATE_FAILED", "Failed to create course")
      );
    }
  }
);

// PATCH /courses/:courseId — admin only
router.patch(
  "/:courseId",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const {title, description, thumbnailUrl, isPublished} = req.body as {
        title?: string;
        description?: string;
        thumbnailUrl?: string;
        isPublished?: boolean;
      };

      const updates: Record<string, unknown> = {
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (thumbnailUrl !== undefined) {
        updates.thumbnailUrl = thumbnailUrl;
      }
      if (isPublished !== undefined) updates.isPublished = isPublished;

      await adminDb.collection("courses").doc(courseId).update(updates);
      const updated = await adminDb
        .collection("courses").doc(courseId).get();

      res.json(success({
        id: updated.id,
        ...(normalizeFirestoreData(updated.data()) as Record<
          string, unknown
        >),
      }));
    } catch {
      res.status(500).json(
        error("UPDATE_FAILED", "Failed to update course")
      );
    }
  }
);

// DELETE /courses/:courseId — admin only
router.delete(
  "/:courseId",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      await adminDb.collection("courses").doc(courseId).delete();
      res.json(success({id: courseId, deleted: true}));
    } catch {
      res.status(500).json(
        error("DELETE_FAILED", "Failed to delete course")
      );
    }
  }
);

export default router;
