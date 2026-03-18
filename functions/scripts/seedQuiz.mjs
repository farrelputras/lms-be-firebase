import "dotenv/config";
import {adminDb} from "../lib/firebaseAdmin.js";

const COURSE_ID = process.env.COURSE_ID || "3bViFooKRQSBQxVLjGIJ";
if (!COURSE_ID) {
  throw new Error("Missing COURSE_ID. Set env COURSE_ID=<courseId> before running the script.");
}

// Optional custom title for quick reseeding.
const QUIZ_TITLE = process.env.QUIZ_TITLE || "Quiz Ekonomi Syariah - Test MVP";

const quizData = {
  title: QUIZ_TITLE,
  type: "preTest",
  gamificationType: "standard",
  courseId: COURSE_ID,
  passingGrade: 3,
  showAnswers: true,
  allowRetake: true,
  questions: [
    {
      questionText: "Apa kepanjangan dari ZISWAF?",
      correctAnswerText: "",
      // correctAnswerIndex: 0 means "Zakat, Infak, Sedekah, Wakaf" is correct
      correctAnswerIndex: 0,
      options: [
        "Zakat, Infak, Sedekah, Wakaf",  // index 0 — correct
        "Zakat, Iman, Syariah, Wakaf",    // index 1
        "Zakat, Infak, Syariah, Waris",   // index 2
        "Zakat, Iman, Sedekah, Waris",    // index 3
      ],
      type: "multipleChoice",
      points: 1,
    },
    {
      questionText: "Sistem bunga dalam perbankan konvensional disebut?",
      correctAnswerText: "",
      // correctAnswerIndex: 1 means "Riba" is correct
      correctAnswerIndex: 1,
      options: [
        "Mudharabah",  // index 0
        "Riba",        // index 1 — correct
        "Musyarakah",  // index 2
        "Murabahah",   // index 3
      ],
      type: "multipleChoice",
      points: 1,
    },
    {
      questionText: "Akad jual beli dengan harga pokok ditambah keuntungan disepakati disebut?",
      correctAnswerText: "",
      // correctAnswerIndex: 2 means "Murabahah" is correct
      correctAnswerIndex: 2,
      options: [
        "Mudharabah",  // index 0
        "Ijarah",      // index 1
        "Murabahah",   // index 2 — correct
        "Musyarakah",  // index 3
      ],
      type: "multipleChoice",
      points: 1,
    },
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
};

async function seed() {
  const quizRef = adminDb
    .collection("courses")
    .doc(COURSE_ID)
    .collection("quizzes")
    .doc(); // Firestore auto-generates the ID

  await quizRef.set(quizData);

  console.log("✅ Quiz created successfully");
  console.log(`Quiz ID: ${quizRef.id}`);
  console.log(`Course ID: ${COURSE_ID}`);
  console.log("\nCopy the Quiz ID above — you will need it as :quizId in Postman.");
}

seed().catch(console.error);