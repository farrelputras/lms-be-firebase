import {checkAndAwardBadges} from "../lib/utils/badges.js";

class MockFirestore {
  constructor(initialUsers) {
    this.users = new Map(Object.entries(initialUsers));
  }

  collection(name) {
    if (name !== "users") {
      throw new Error(`Unsupported collection: ${name}`);
    }

    const db = this;
    return {
      doc(uid) {
        return {
          async get() {
            const data = db.users.get(uid);
            return {
              exists: data !== undefined,
              id: uid,
              data: () => data,
            };
          },
          async set(payload, options) {
            const current = db.users.get(uid) || {};
            const merged = options?.merge ? {...current, ...payload} : payload;
            db.users.set(uid, merged);
          },
        };
      },
      orderBy(field, direction) {
        if (field !== "totalPoints" || direction !== "desc") {
          throw new Error("Unsupported orderBy configuration");
        }

        return {
          limit(count) {
            return {
              async get() {
                const docs = [...db.users.entries()]
                  .map(([id, data]) => ({
                    id,
                    totalPoints:
                      typeof data.totalPoints === "number" ? data.totalPoints : 0,
                  }))
                  .sort((a, b) => b.totalPoints - a.totalPoints)
                  .slice(0, count)
                  .map((entry) => ({id: entry.id}));

                return {docs};
              },
            };
          },
        };
      },
    };
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run() {
  {
    const db = new MockFirestore({
      u1: {badges: [], totalPoints: 100},
      u2: {badges: [], totalPoints: 90},
      u3: {badges: [], totalPoints: 80},
      u4: {badges: [], totalPoints: 70},
    });

    const awarded = await checkAndAwardBadges(
      "u1",
      db,
      {type: "quiz_submit", correctCount: 10, totalQuestions: 10}
    );

    assert(
      awarded.includes("perfect_score") && awarded.includes("top_3"),
      "Case 1 failed: expected perfect_score and top_3"
    );

    const badges = db.users.get("u1").badges;
    assert(
      badges.includes("perfect_score") && badges.includes("top_3"),
      "Case 1 failed: badges not saved"
    );
  }

  {
    const db = new MockFirestore({
      u1: {badges: ["perfect_score", "top_3"], totalPoints: 100},
      u2: {badges: [], totalPoints: 90},
      u3: {badges: [], totalPoints: 80},
    });

    const awarded = await checkAndAwardBadges(
      "u1",
      db,
      {type: "quiz_submit", correctCount: 10, totalQuestions: 10}
    );

    assert(awarded.length === 0, "Case 2 failed: expected no new badges");
    assert(
      db.users.get("u1").badges.filter((b) => b === "top_3").length === 1,
      "Case 2 failed: duplicate top_3 badge"
    );
  }

  {
    const db = new MockFirestore({
      u1: {badges: [], totalPoints: 50},
      u2: {badges: [], totalPoints: 45},
      u3: {badges: [], totalPoints: 40},
      u4: {badges: [], totalPoints: 10},
    });

    const awarded = await checkAndAwardBadges("u1", db, {type: "points_update"});
    assert(
      awarded.length === 1 && awarded[0] === "top_3",
      "Case 3 failed: expected only top_3"
    );
  }

  {
    const db = new MockFirestore({
      u1: {badges: [], totalPoints: 5},
      u2: {badges: [], totalPoints: 45},
      u3: {badges: [], totalPoints: 40},
      u4: {badges: [], totalPoints: 10},
    });

    const awarded = await checkAndAwardBadges(
      "u1",
      db,
      {type: "quiz_submit", correctCount: 2, totalQuestions: 10}
    );

    assert(awarded.length === 0, "Case 4 failed: expected no badges");
  }

  {
    const db = new MockFirestore({
      u2: {badges: [], totalPoints: 45},
      u3: {badges: [], totalPoints: 40},
      u4: {badges: [], totalPoints: 10},
    });

    const awarded = await checkAndAwardBadges(
      "u1",
      db,
      {type: "quiz_submit", correctCount: 3, totalQuestions: 3}
    );

    assert(
      awarded.length === 1 && awarded[0] === "perfect_score",
      "Case 5 failed: expected only perfect_score for missing user doc"
    );
    assert(
      Array.isArray(db.users.get("u1")?.badges) &&
        db.users.get("u1")?.badges.includes("perfect_score"),
      "Case 5 failed: expected missing user doc to be created with perfect_score"
    );
  }

  {
    const db = new MockFirestore({
      u1: {badges: "invalid", totalPoints: 50},
      u2: {badges: [], totalPoints: 45},
      u3: {badges: [], totalPoints: 40},
      u4: {badges: [], totalPoints: 10},
    });

    const awarded = await checkAndAwardBadges("u1", db, {type: "points_update"});
    assert(
      awarded.length === 1 && awarded[0] === "top_3",
      "Case 6 failed: expected top_3 when badges field is malformed"
    );
    assert(
      db.users.get("u1").badges.length === 1 &&
        db.users.get("u1").badges[0] === "top_3",
      "Case 6 failed: malformed badges should be replaced with valid badge array"
    );
  }

  {
    const db = new MockFirestore({
      u1: {badges: [], totalPoints: 100},
      u2: {badges: [], totalPoints: 90},
      u3: {badges: [], totalPoints: 80},
    });

    const awarded = await checkAndAwardBadges(
      "u1",
      db,
      {type: "quiz_submit", correctCount: 0, totalQuestions: 0}
    );

    assert(
      awarded.includes("perfect_score") && awarded.includes("top_3"),
      "Case 7 failed: expected zero-question perfect equality to award current badges"
    );
  }

  {
    const db = new MockFirestore({
      u1: {badges: [], totalPoints: 100},
      u2: {badges: [], totalPoints: 90},
      u3: {badges: [], totalPoints: 80},
      u4: {badges: [], totalPoints: 79},
    });

    const awardedTop3 = await checkAndAwardBadges("u3", db, {type: "points_update"});
    const awardedNotTop3 = await checkAndAwardBadges("u4", db, {type: "points_update"});

    assert(
      awardedTop3.length === 1 && awardedTop3[0] === "top_3",
      "Case 8 failed: expected rank-3 user to receive top_3"
    );
    assert(
      awardedNotTop3.length === 0,
      "Case 8 failed: expected rank-4 user to receive no top_3"
    );
  }

  console.log("All badge utility tests passed.");
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
