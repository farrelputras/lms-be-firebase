import {Request, Response, NextFunction} from "express";
import {adminDb} from "../firebaseAdmin.js";
import {error} from "../utils/response.js";

/**
 * requirePremiumEnrollment
 *
 * Tier-aware enrollment gate for student content reads.
 * - Free / absent-tier courses: no-op (next() immediately) — today's behavior unchanged.
 * - Premium courses: requires an enrollments doc for the caller; else 403 PREMIUM_NOT_ENROLLED.
 * - Admins: bypass unconditionally.
 *
 * Self-sufficient — does its own course read; does NOT depend on requirePublishedCourse.
 * Middleware order on gated routes: verifyToken → requirePublishedCourse → requirePremiumEnrollment → handler
 */
export const requirePremiumEnrollment = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // 1. Must be authenticated (verifyToken should have set this)
    if (!req.user) {
      res.status(401).json(error("UNAUTHORIZED", "Authentication required"));
      return;
    }

    // 2. Admins bypass — they can read any course regardless of tier/enrollment
    if (req.user.role === "admin") {
      next();
      return;
    }

    // 3. courseId must be present (mergeParams:true on sub-routers supplies this)
    const courseId = req.params.courseId as string | undefined;
    if (!courseId) {
      res.status(400).json(error("BAD_REQUEST", "courseId is required"));
      return;
    }

    // 4. Load course doc — guard against existence leak
    const courseSnap = await adminDb.collection("courses").doc(courseId).get();
    if (!courseSnap.exists) {
      res.status(404).json(error("NOT_FOUND", "Course not found"));
      return;
    }

    // 5. Free / absent tier — no-op; gate is inert on all existing free courses
    const courseData = courseSnap.data() as {accessTier?: string};
    if (courseData.accessTier !== "premium") {
      next();
      return;
    }

    // 6. Premium: enrollment doc required
    const uid = req.user.uid;
    const enrollmentSnap = await adminDb
      .collection("enrollments")
      .where("userId", "==", uid)
      .where("courseId", "==", courseId)
      .limit(1)
      .get();

    if (!enrollmentSnap.empty) {
      next();
      return;
    }

    res.status(403).json(
      error(
        "PREMIUM_NOT_ENROLLED",
        "This is a premium course. Request access from the admin to enroll."
      )
    );
  } catch (err: unknown) {
    console.error({
      middleware: "requirePremiumEnrollment",
      uid: req.user?.uid,
      courseId: req.params.courseId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json(
      error("ENROLLMENT_GATE_FAILED", "Failed to verify course enrollment")
    );
  }
};
