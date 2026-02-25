import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {
  adminDb, mapDoc, normalizeFirestoreData,
} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {requireRole} from "../middleware/requireRole.js";
import {checkEnrollment} from "../middleware/checkEnrollment.js";
import {success, error} from "../utils/response.js";

const router = Router({mergeParams: true});

// GET /courses/:courseId/chapters — auth + enrolled or admin
router.get("/", verifyToken, checkEnrollment, async (req, res) => {
  try {
    const courseId = req.params.courseId as string;
    const snapshot = await adminDb
      .collection("courses")
      .doc(courseId)
      .collection("chapters")
      .orderBy("order")
      .get();

    const chapters = snapshot.docs.map((docSnap) => mapDoc(docSnap));
    res.json(success(chapters));
  } catch {
    res.status(500).json(
      error("FETCH_FAILED", "Failed to fetch chapters")
    );
  }
});

// GET /courses/:courseId/chapters/:chapterId
router.get(
  "/:chapterId",
  verifyToken,
  checkEnrollment,
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const chapterId = req.params.chapterId as string;
      const docSnap = await adminDb
        .collection("courses")
        .doc(courseId)
        .collection("chapters")
        .doc(chapterId)
        .get();

      if (!docSnap.exists) {
        res.status(404).json(
          error("NOT_FOUND", "Chapter not found")
        );
        return;
      }

      res.json(success({
        id: docSnap.id,
        ...(normalizeFirestoreData(docSnap.data()) as Record<
          string, unknown
        >),
      }));
    } catch {
      res.status(500).json(
        error("FETCH_FAILED", "Failed to fetch chapter")
      );
    }
  }
);

// POST /courses/:courseId/chapters — admin only
router.post(
  "/",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const {title, content, videoUrl, order} = req.body as {
        title?: string;
        content?: string;
        videoUrl?: string;
        order?: number;
      };

      if (!title) {
        res.status(400).json(
          error("BAD_REQUEST", "title is required")
        );
        return;
      }

      const chapterData = {
        title,
        content: content || "",
        videoUrl: videoUrl || "",
        order: order ?? 0,
        createdAt: FieldValue.serverTimestamp(),
      };

      const docRef = await adminDb
        .collection("courses")
        .doc(courseId)
        .collection("chapters")
        .add(chapterData);

      res.status(201).json(success({id: docRef.id, ...chapterData}));
    } catch {
      res.status(500).json(
        error("CREATE_FAILED", "Failed to create chapter")
      );
    }
  }
);

// PATCH /courses/:courseId/chapters/:chapterId — admin only
router.patch(
  "/:chapterId",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const chapterId = req.params.chapterId as string;
      const {title, content, videoUrl, order} = req.body as {
        title?: string;
        content?: string;
        videoUrl?: string;
        order?: number;
      };

      const updates: Record<string, unknown> = {};
      if (title !== undefined) updates.title = title;
      if (content !== undefined) updates.content = content;
      if (videoUrl !== undefined) updates.videoUrl = videoUrl;
      if (order !== undefined) updates.order = order;

      await adminDb
        .collection("courses")
        .doc(courseId)
        .collection("chapters")
        .doc(chapterId)
        .update(updates);

      const updated = await adminDb
        .collection("courses")
        .doc(courseId)
        .collection("chapters")
        .doc(chapterId)
        .get();

      res.json(success({
        id: updated.id,
        ...(normalizeFirestoreData(updated.data()) as Record<
          string, unknown
        >),
      }));
    } catch {
      res.status(500).json(
        error("UPDATE_FAILED", "Failed to update chapter")
      );
    }
  }
);

// DELETE /courses/:courseId/chapters/:chapterId — admin only
router.delete(
  "/:chapterId",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const chapterId = req.params.chapterId as string;
      await adminDb
        .collection("courses")
        .doc(courseId)
        .collection("chapters")
        .doc(chapterId)
        .delete();

      res.json(success({id: chapterId, deleted: true}));
    } catch {
      res.status(500).json(
        error("DELETE_FAILED", "Failed to delete chapter")
      );
    }
  }
);

export default router;
