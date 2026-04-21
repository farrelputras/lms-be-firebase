import {Request, Response, NextFunction} from "express";

import {adminDb} from "../firebaseAdmin.js";

export const requirePublishedCourse = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: {code: "UNAUTHORIZED", message: "Authentication required"},
    });
    return;
  }

  // Keep admin access to support course authoring and moderation workflows.
  if (req.user.role === "admin") {
    next();
    return;
  }

  const rawCourseId = req.params.courseId;
  const courseId = typeof rawCourseId === "string" ? rawCourseId : "";
  if (!courseId) {
    res.status(400).json({
      success: false,
      error: {code: "BAD_REQUEST", message: "courseId is required"},
    });
    return;
  }

  try {
    const courseSnap = await adminDb.collection("courses").doc(courseId).get();

    if (!courseSnap.exists) {
      res.status(404).json({
        success: false,
        error: {code: "NOT_FOUND", message: "Course not found"},
      });
      return;
    }

    const isPublished = courseSnap.data()?.isPublished === true;
    if (!isPublished) {
      res.status(404).json({
        success: false,
        error: {code: "NOT_FOUND", message: "Course not found"},
      });
      return;
    }

    next();
  } catch {
    res.status(500).json({
      success: false,
      error: {
        code: "COURSE_VISIBILITY_CHECK_FAILED",
        message: "Failed to verify course visibility",
      },
    });
  }
};