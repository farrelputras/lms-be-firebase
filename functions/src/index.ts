import cors from "cors";
import express from "express";
import {FieldValue} from "firebase-admin/firestore";
import {onRequest} from "firebase-functions/v2/https";
import {setGlobalOptions} from "firebase-functions/v2/options";

import {adminDb, mapDoc, normalizeFirestoreData} from "./firebaseAdmin.js";

setGlobalOptions({maxInstances: 10});

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? ["http://localhost:3000"],
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ok: true, service: "lms-be-firebase"});
});

app.get("/v1/courses", async (_req, res) => {
  try {
    const snapshot = await adminDb.collection("courses").get();
    const courses = snapshot.docs.map((docSnap) => mapDoc(docSnap));
    res.json(courses);
  } catch {
    res.status(500).json({message: "Failed to fetch courses"});
  }
});

app.get("/v1/courses/:courseId", async (req, res) => {
  try {
    const {courseId} = req.params;
    const docSnap = await adminDb.collection("courses").doc(courseId).get();

    if (!docSnap.exists) {
      res.status(404).json({message: "Course not found"});
      return;
    }

    res.json({
      id: docSnap.id,
      ...(normalizeFirestoreData(docSnap.data()) as Record<string, unknown>),
    });
  } catch {
    res.status(500).json({message: "Failed to fetch course detail"});
  }
});

app.get("/v1/courses/:courseId/chapters", async (req, res) => {
  try {
    const {courseId} = req.params;
    const snapshot = await adminDb
      .collection("courses")
      .doc(courseId)
      .collection("chapters")
      .orderBy("order")
      .get();

    const chapters = snapshot.docs.map((docSnap) => mapDoc(docSnap));
    res.json(chapters);
  } catch {
    res.status(500).json({message: "Failed to fetch chapters"});
  }
});

app.get("/v1/courses/:courseId/chapters/:chapterId", async (req, res) => {
  try {
    const {courseId, chapterId} = req.params;
    const docSnap = await adminDb
      .collection("courses")
      .doc(courseId)
      .collection("chapters")
      .doc(chapterId)
      .get();

    if (!docSnap.exists) {
      res.status(404).json({message: "Chapter not found"});
      return;
    }

    res.json({
      id: docSnap.id,
      ...(normalizeFirestoreData(docSnap.data()) as Record<string, unknown>),
    });
  } catch {
    res.status(500).json({message: "Failed to fetch chapter detail"});
  }
});

app.get("/v1/courses/:courseId/quizzes", async (req, res) => {
  try {
    const {courseId} = req.params;
    const snapshot = await adminDb
      .collection("courses")
      .doc(courseId)
      .collection("quizzes")
      .get();

    const quizzes = snapshot.docs.map((docSnap) => mapDoc(docSnap));
    res.json(quizzes);
  } catch {
    res.status(500).json({message: "Failed to fetch quizzes"});
  }
});

app.get("/v1/courses/:courseId/quizzes/:quizId", async (req, res) => {
  try {
    const {courseId, quizId} = req.params;
    const docSnap = await adminDb
      .collection("courses")
      .doc(courseId)
      .collection("quizzes")
      .doc(quizId)
      .get();

    if (!docSnap.exists) {
      res.status(404).json({message: "Quiz not found"});
      return;
    }

    res.json({
      id: docSnap.id,
      ...(normalizeFirestoreData(docSnap.data()) as Record<string, unknown>),
    });
  } catch {
    res.status(500).json({message: "Failed to fetch quiz detail"});
  }
});

app.get("/v1/progress", async (req, res) => {
  const userId = req.query.userId as string | undefined;
  if (!userId) {
    res.status(400).json({message: "userId is required"});
    return;
  }

  try {
    const snapshot = await adminDb
      .collection("progress")
      .where("userId", "==", userId)
      .get();
    const progress = snapshot.docs.map((docSnap) => mapDoc(docSnap));
    res.json(progress);
  } catch {
    res.status(500).json({message: "Failed to fetch user progress"});
  }
});

app.get("/v1/progress/by-course", async (req, res) => {
  const userId = req.query.userId as string | undefined;
  const courseId = req.query.courseId as string | undefined;

  if (!userId || !courseId) {
    res.status(400).json({message: "userId and courseId are required"});
    return;
  }

  try {
    const snapshot = await adminDb
      .collection("progress")
      .where("userId", "==", userId)
      .where("courseId", "==", courseId)
      .get();

    const progressDetail = snapshot.docs.map((docSnap) => {
      const data = docSnap.data();
      return {
        chapterId: (data.chapterId as string) || "",
        isCompleted: Boolean(data.isCompleted),
        pointsAwarded:
          typeof data.pointsAwarded === "number" ? data.pointsAwarded : 0,
      };
    });

    res.json({userId, courseId, progressDetail});
  } catch {
    res.status(500).json({message: "Failed to fetch progress by course"});
  }
});

app.post("/v1/progress", async (req, res) => {
  const {userId, courseId, chapterId} = req.body as {
    userId?: string;
    courseId?: string;
    chapterId?: string;
  };

  if (!userId || !courseId || !chapterId) {
    res.status(400).json({
      message: "userId, courseId, and chapterId are required",
    });
    return;
  }

  const progressId = `${courseId}_${chapterId}_${userId}`;
  const payload = {
    userId,
    courseId,
    chapterId,
    isCompleted: true,
    pointsAwarded: 0,
    completedAt: FieldValue.serverTimestamp(),
  };

  try {
    await adminDb.collection("progress").doc(progressId).set(payload, {
      merge: true,
    });

    res.status(201).json({id: progressId, ...payload, completedAt: null});
  } catch {
    res.status(500).json({message: "Failed to create progress"});
  }
});

app.get("/v1/leaderboard", async (_req, res) => {
  try {
    const snapshot = await adminDb
      .collection("users")
      .orderBy("totalPoints", "desc")
      .get();

    const users = snapshot.docs.map((docSnap) => {
      const data = docSnap.data();
      return {
        uid: docSnap.id,
        displayName: (data.displayName as string) || "",
        totalPoints:
          typeof data.totalPoints === "number" ? data.totalPoints : 0,
      };
    });

    res.json(users);
  } catch {
    res.status(500).json({message: "Failed to fetch leaderboard"});
  }
});

app.get("/v1/users/:userId", async (req, res) => {
  try {
    const {userId} = req.params;
    const docSnap = await adminDb.collection("users").doc(userId).get();

    if (!docSnap.exists) {
      res.status(404).json({message: "User not found"});
      return;
    }

    res.json({
      uid: docSnap.id,
      ...(normalizeFirestoreData(docSnap.data()) as Record<string, unknown>),
    });
  } catch {
    res.status(500).json({message: "Failed to fetch user detail"});
  }
});

app.post("/v1/users/upsert", async (req, res) => {
  const {uid, email, displayName} = req.body as {
    uid?: string;
    email?: string;
    displayName?: string;
  };

  if (!uid || !email) {
    res.status(400).json({message: "uid and email are required"});
    return;
  }

  try {
    const userRef = adminDb.collection("users").doc(uid);
    const existing = await userRef.get();

    if (!existing.exists) {
      await userRef.set({
        uid,
        email,
        displayName: displayName || email.split("@")[0],
        role: "student",
        totalPoints: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      await userRef.set(
        {
          email,
          displayName: displayName || existing.data()?.displayName || "",
          updatedAt: FieldValue.serverTimestamp(),
        },
        {merge: true}
      );
    }

    const latest = await userRef.get();
    res.json({
      uid: latest.id,
      ...(normalizeFirestoreData(latest.data()) as Record<string, unknown>),
    });
  } catch {
    res.status(500).json({message: "Failed to upsert user profile"});
  }
});

export const api = onRequest(
  {
    cors: false,
  },
  app
);
