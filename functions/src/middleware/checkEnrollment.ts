import {Request, Response, NextFunction} from "express";

import {adminDb} from "../firebaseAdmin.js";

export const checkEnrollment = async (
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

  // Admins bypass enrollment check
  if (req.user.role === "admin") {
    next();
    return;
  }

  const courseId = req.params.courseId;
  if (!courseId) {
    res.status(400).json({
      success: false,
      error: {code: "BAD_REQUEST", message: "courseId is required"},
    });
    return;
  }

  try {
    const snapshot = await adminDb
      .collection("enrollments")
      .where("userId", "==", req.user.uid)
      .where("courseId", "==", courseId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "You must be enrolled in this course",
        },
      });
      return;
    }

    next();
  } catch {
    res.status(500).json({
      success: false,
      error: {
        code: "ENROLLMENT_CHECK_FAILED",
        message: "Failed to verify enrollment",
      },
    });
  }
};
