// Compute prize rankings from pilot-study data (read-only analysis).
//
// Eligibility: bestScorePercent === 100 on ALL course activities AND
//   every published chapter in progress.completedChapters.
// Ranking: per-medium (Web / Mobile), sorted attempts ASC then completionTime ASC.
// Top 6 per medium are the prize winners.
//
// Usage (PowerShell), from lms-be-firebase/functions/ :
//   npm run build
//   $env:COURSE_ID = "<courseId>"
//   node scripts/computePrizeRanking.mjs
// Or pass COURSE_ID as first argument:
//   node scripts/computePrizeRanking.mjs <courseId>

import "dotenv/config";
import { adminDb } from "../lib/firebaseAdmin.js";
import { writeFileSync } from "node:fs";

// const COURSE_ID = process.env.COURSE_ID || process.argv[2];
const COURSE_ID = "sU7RqyyV32JvFo7IyP6G";
if (!COURSE_ID) {
  console.error("Error: COURSE_ID is required.\nUsage: $env:COURSE_ID=\"<id>\" ; node scripts/computePrizeRanking.mjs");
  process.exit(1);
}

// ── helpers ───────────────────────────────────────────────────────────────────

const ROSTER_RE = /^murid(\d+)@eduloca\.tech$/i;

function parseN(email) {
  const m = ROSTER_RE.exec(email ?? "");
  return m ? parseInt(m[1], 10) : null;
}

function deriveMedium(n) {
  if ((n >= 1 && n <= 15) || (n >= 31 && n <= 45)) return "Web";
  if ((n >= 16 && n <= 30) || (n >= 46 && n <= 60)) return "Mobile";
  return null;
}

// N in 1–30 → chatbot expected; N in 31–60 → no chatbot
function chatbotByN(n) {
  return n >= 1 && n <= 30;
}

function fmtDate(d) {
  if (!d) return "";
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Course: ${COURSE_ID}`);

  // READ 1: all activities for this course (denominator for eligibility)
  const activitiesSnap = await adminDb
    .collection("courses")
    .doc(COURSE_ID)
    .collection("gamification")
    .get();
  const allActivityIds = new Set(activitiesSnap.docs.map((d) => d.id));
  const totalActivities = allActivityIds.size;
  console.log(`Activities found: ${totalActivities}`);

  // READ 2: all chapters for this course
  const chaptersSnap = await adminDb
    .collection("courses")
    .doc(COURSE_ID)
    .collection("chapters")
    .get();
  // treat isPublished !== false as published (mirrors CLAUDE.md spec)
  const publishedChapterIds = new Set(
    chaptersSnap.docs
      .filter((d) => d.data().isPublished !== false)
      .map((d) => d.id)
  );
  const totalChapters = publishedChapterIds.size;
  console.log(`Published chapters found: ${totalChapters}`);

  // READ 3: all activity_progress for this course in one batch query
  const apSnap = await adminDb
    .collection("activity_progress")
    .where("courseId", "==", COURSE_ID)
    .get();
  console.log(`Activity-progress docs: ${apSnap.size}`);

  // Group by userId → activityId
  /** @type {Map<string, Map<string, {attempts:number, bestScorePercent:number, lastAttemptAt:Date|null}>>} */
  const apByUser = new Map();
  for (const doc of apSnap.docs) {
    const d = doc.data();
    const uid = typeof d.userId === "string" ? d.userId : "";
    if (!uid) continue;
    // prefer stored activityId field; fall back to doc ID suffix
    const activityId =
      typeof d.activityId === "string"
        ? d.activityId
        : doc.id.includes("_")
        ? doc.id.split("_").slice(1).join("_")
        : "";
    if (!activityId) continue;
    if (!apByUser.has(uid)) apByUser.set(uid, new Map());
    apByUser.get(uid).set(activityId, {
      attempts: typeof d.attempts === "number" ? d.attempts : 0,
      bestScorePercent:
        typeof d.bestScorePercent === "number" ? d.bestScorePercent : 0,
      lastAttemptAt: d.lastAttemptAt?.toDate?.() ?? null,
    });
  }

  // READ 4: all users (small collection — 60 roster + a handful of admins)
  const usersSnap = await adminDb.collection("users").get();
  const rosterUsers = [];
  for (const doc of usersSnap.docs) {
    const d = doc.data();
    const email = typeof d.email === "string" ? d.email.trim() : "";
    const n = parseN(email);
    if (n === null || n < 1 || n > 60) continue;
    rosterUsers.push({
      uid: doc.id,
      name: typeof d.name === "string" ? d.name : email.split("@")[0],
      email,
      n,
      chatbotEnabledInDB:
        typeof d.chatbotEnabled === "boolean" ? d.chatbotEnabled : false,
    });
  }
  console.log(`Roster users matched: ${rosterUsers.length}`);

  // READ 5: per-user course-progress docs (up to 60 point reads, parallelized)
  const progressMap = new Map(); // uid → completedChapters string[]
  await Promise.all(
    rosterUsers.map(async (u) => {
      const snap = await adminDb
        .collection("progress")
        .doc(`${u.uid}_${COURSE_ID}`)
        .get();
      const data = snap.exists ? snap.data() : null;
      progressMap.set(
        u.uid,
        Array.isArray(data?.completedChapters) ? data.completedChapters : []
      );
    })
  );

  // ── compute per-student metrics ───────────────────────────────────────────

  const rows = [];
  for (const u of rosterUsers) {
    const medium = deriveMedium(u.n);
    if (!medium) continue;

    const chatbotExpected = chatbotByN(u.n);
    const chatbotMismatch = u.chatbotEnabledInDB !== chatbotExpected;

    const userAP = apByUser.get(u.uid) ?? new Map();
    const completedChapters = progressMap.get(u.uid) ?? [];

    let perfectCount = 0;
    let totalAttempts = 0;
    let maxDate = null;

    for (const activityId of allActivityIds) {
      const ap = userAP.get(activityId);
      if (ap) {
        totalAttempts += ap.attempts;
        if (ap.bestScorePercent === 100) perfectCount++;
        if (ap.lastAttemptAt) {
          if (!maxDate || ap.lastAttemptAt > maxDate) maxDate = ap.lastAttemptAt;
        }
      }
    }

    const doneChapters = completedChapters.filter((id) =>
      publishedChapterIds.has(id)
    ).length;

    // Both conditions must hold for eligibility
    const eligible =
      perfectCount === totalActivities && doneChapters === totalChapters;

    rows.push({
      uid: u.uid,
      medium,
      rank: "",
      name: u.name,
      email: u.email,
      n: u.n,
      chatbot: chatbotExpected ? "Yes" : "No",
      chatbotMismatch,
      eligible,
      activitiesPerfect: `${perfectCount}/${totalActivities}`,
      chaptersComplete: `${doneChapters}/${totalChapters}`,
      totalAttempts,
      completionTime: fmtDate(maxDate),
      _sortDate: maxDate,
    });
  }

  // ── rank within each medium ───────────────────────────────────────────────

  const rankMedium = (medium) => {
    const eligible = rows.filter((r) => r.medium === medium && r.eligible);
    eligible.sort((a, b) => {
      if (a.totalAttempts !== b.totalAttempts)
        return a.totalAttempts - b.totalAttempts;
      const at = a._sortDate?.getTime() ?? Infinity;
      const bt = b._sortDate?.getTime() ?? Infinity;
      return at - bt;
    });
    eligible.forEach((r, i) => {
      r.rank = String(i + 1);
    });
    return eligible;
  };

  const webRanked = rankMedium("Web");
  const mobileRanked = rankMedium("Mobile");

  // ── terminal tables ───────────────────────────────────────────────────────

  const COL = { rank: 4, name: 22, email: 32, chatbot: 7, attempts: 8 };
  const printTable = (label, ranked) => {
    console.log(`\n=== ${label} ===`);
    const top6 = ranked.slice(0, 6);
    if (top6.length === 0) {
      console.log("  (no eligible students)");
      return;
    }
    const hdr =
      "Rank" +
      "  " +
      "Name".padEnd(COL.name) +
      "  " +
      "Email".padEnd(COL.email) +
      "  " +
      "Chatbot".padEnd(COL.chatbot) +
      "  " +
      "Attempts".padStart(COL.attempts) +
      "  CompletedAt";
    console.log(hdr);
    console.log("-".repeat(hdr.length));
    for (const s of top6) {
      console.log(
        s.rank.padStart(COL.rank) +
          "  " +
          s.name.padEnd(COL.name).slice(0, COL.name) +
          "  " +
          s.email.padEnd(COL.email).slice(0, COL.email) +
          "  " +
          s.chatbot.padEnd(COL.chatbot) +
          "  " +
          String(s.totalAttempts).padStart(COL.attempts) +
          "  " +
          s.completionTime
      );
    }
  };

  printTable("WEB (top 6)", webRanked);
  printTable("MOBILE (top 6)", mobileRanked);

  // ── write CSV ─────────────────────────────────────────────────────────────

  // Sort: medium ASC, then eligible (ranked) first, then ineligible by N
  const sorted = [...rows].sort((a, b) => {
    if (a.medium < b.medium) return -1;
    if (a.medium > b.medium) return 1;
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.eligible) {
      return (parseInt(a.rank) || Infinity) - (parseInt(b.rank) || Infinity);
    }
    return a.n - b.n;
  });

  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const CSV_HEADER =
    "medium,rank,name,email,n,chatbot,chatbotMismatch,eligible,activitiesPerfect,chaptersComplete,totalAttempts,completionTime";
  const csvLines = [CSV_HEADER];
  for (const r of sorted) {
    csvLines.push(
      [
        r.medium,
        r.rank,
        esc(r.name),
        r.email,
        r.n,
        r.chatbot,
        r.chatbotMismatch ? "yes" : "",
        r.eligible ? "yes" : "no",
        r.activitiesPerfect,
        r.chaptersComplete,
        r.totalAttempts,
        esc(r.completionTime),
      ].join(",")
    );
  }

  const csvPath = `scripts/prize-ranking-${nowStamp()}.csv`;
  writeFileSync(csvPath, csvLines.join("\n"), "utf8");

  console.log(`\nCSV written -> ${csvPath}  (${sorted.length} roster students)`);
  console.log(
    `Summary: activities=${totalActivities}  published_chapters=${totalChapters}  ` +
      `web_eligible=${webRanked.length}  mobile_eligible=${mobileRanked.length}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err?.message ?? err);
    process.exit(1);
  });
