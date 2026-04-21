import "dotenv/config";
import cors from "cors";
import express from "express";
import {onRequest} from "firebase-functions/v2/https";
import {setGlobalOptions} from "firebase-functions/v2/options";

import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import coursesRouter from "./routes/courses.js";
import chaptersRouter from "./routes/chapters.js";
import quizzesRouter from "./routes/quizzes.js";
import activitiesRouter from "./routes/activities.js";
import contentRouter from "./routes/content.js";
import progressRouter from "./routes/progress.js";
import storageRouter from "./routes/storage.js";
import leaderboardRouter from "./routes/leaderboard.js";
import mediaRouter from "./routes/media.js";

setGlobalOptions({maxInstances: 10});

const app = express();

app.use(
  cors({
    // origin: process.env.CORS_ORIGIN?.split(",") ?? ["http://localhost:3000"],
    origin: "*",
  })
);
app.use((req, res, next) => {
  if (req.headers['content-type']?.startsWith('multipart/form-data')) {
    return next(); // skip body parsing entirely, let multer handle it
  }
  express.json()(req, res, next);
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ok: true, service: "lms-be-firebase"});
});

// Mount route modules
app.use("/v1/auth", authRouter);
app.use("/v1/users", usersRouter);
app.use("/v1/courses", coursesRouter);
app.use("/v1/courses/:courseId/chapters", chaptersRouter);
app.use("/v1/courses/:courseId/quizzes", quizzesRouter);
app.use("/v1/courses/:courseId/activities", activitiesRouter);
app.use("/v1/courses/:courseId/content", contentRouter);
app.use("/v1/courses/:courseId/progress", progressRouter);
app.use("/v1/storage", storageRouter);
app.use("/v1/leaderboard", leaderboardRouter);
app.use("/v1/media", mediaRouter);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled Express Error:", err);
  res.status(500).json({ 
    success: false, 
    error: { code: "INTERNAL_ERROR", message: err.message } 
  });
});

export const api = onRequest(
  {
    memory: "512MiB",
    timeoutSeconds: 60,
  },
  (req, res) => {
    if (req.rawBody && req.headers['content-type']?.startsWith('multipart/form-data')) {
      const { Readable } = require('stream');
      const readable = new Readable();
      readable.push(req.rawBody);
      readable.push(null);
      Object.assign(req, readable);
    }
    app(req, res);
  }
);