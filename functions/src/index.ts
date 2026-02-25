import cors from "cors";
import express from "express";
import {onRequest} from "firebase-functions/v2/https";
import {setGlobalOptions} from "firebase-functions/v2/options";

import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import coursesRouter from "./routes/courses.js";
import chaptersRouter from "./routes/chapters.js";
import quizzesRouter from "./routes/quizzes.js";
import enrollmentsRouter from "./routes/enrollments.js";
import progressRouter from "./routes/progress.js";
import storageRouter from "./routes/storage.js";
import chatbotRouter from "./routes/chatbot.js";
import leaderboardRouter from "./routes/leaderboard.js";

setGlobalOptions({maxInstances: 10});

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? ["http://localhost:3000"],
  })
);
app.use(express.json());

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
app.use("/v1/enrollments", enrollmentsRouter);
app.use("/v1/progress", progressRouter);
app.use("/v1/storage", storageRouter);
app.use("/v1/chatbot", chatbotRouter);
app.use("/v1/leaderboard", leaderboardRouter);

export const api = onRequest(
  {
    cors: false,
  },
  app
);
