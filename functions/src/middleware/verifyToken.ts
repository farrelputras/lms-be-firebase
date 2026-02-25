import {Request, Response, NextFunction} from "express";

import {adminAuth} from "../firebaseAdmin.js";

export const verifyToken = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({
      success: false,
      error: {code: "UNAUTHORIZED", message: "Missing or invalid token"},
    });
    return;
  }

  try {
    const token = header.split("Bearer ")[1];
    const decoded = await adminAuth.verifyIdToken(token);
    req.user = {
      uid: decoded.uid,
      email: decoded.email || "",
      role: (decoded.role as string) || "student",
    };
    next();
  } catch {
    res.status(401).json({
      success: false,
      error: {code: "UNAUTHORIZED", message: "Invalid or expired token"},
    });
  }
};

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
      req.user = {
        uid: decoded.uid,
        email: decoded.email || "",
        role: (decoded.role as string) || "student",
      };
    } catch {
      // Token invalid — proceed without auth
    }
  }
  next();
};
