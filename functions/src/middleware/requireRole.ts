import {Request, Response, NextFunction} from "express";

export const requireRole = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: {code: "UNAUTHORIZED", message: "Authentication required"},
      });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        error: {code: "FORBIDDEN", message: "Insufficient permissions"},
      });
      return;
    }

    next();
  };
};
