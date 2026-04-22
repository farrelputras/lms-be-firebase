import { Firestore } from "firebase-admin/firestore";

// --- 1. The Centralized Badge Registry ---
// Both mobile and web will reference these IDs and colors
export const BADGE_REGISTRY = {
  'newcomer': {
    name: 'Newcomer',
    icon: 'celebration',
    color: 'blue',
  },
  'first_step': {
    name: 'First Step',
    icon: 'stairs',
    color: 'teal',
  },
  'active_learner': {
    name: 'Active Learner',
    icon: 'auto_stories',
    color: 'orange',
  },
  'perfect_score': {
    name: 'Perfect Score',
    icon: 'verified',
    color: 'amber',
  },
  'top_3': {
    name: 'Top 3 Tier',
    icon: 'military_tech',
    color: 'blueGrey',
  },
  'number_1': {
    name: 'Number 1',
    icon: 'emoji_events',
    color: 'gold', // Or hex code if preferred
  },
} as const;

export type BadgeId = keyof typeof BADGE_REGISTRY;

// --- 2. Defined Events ---
type BadgeEvent =
  | {
      type: "account_created";
    }
  | {
      type: "chapter_finished";
    }
  | {
      type: "activity_submitted";
      correctCount: number;
      totalQuestions: number;
    }
  | {
      type: "leaderboard_update";
    };

// --- 3. The Core Logic Engine ---
export const checkAndAwardBadges = async (
  uid: string,
  db: Firestore,
  event: BadgeEvent
): Promise<BadgeId[]> => {
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();

  if (!userSnap.exists) return [];

  const currentBadges = Array.isArray(userSnap.data()?.badges)
    ? (userSnap.data()?.badges as BadgeId[])
    : [];

  const nextBadges = new Set<BadgeId>(currentBadges);
  const newlyAwarded: BadgeId[] = [];

  // Helper to safely add badges
  const awardBadge = (badgeId: BadgeId) => {
    if (!nextBadges.has(badgeId)) {
      nextBadges.add(badgeId);
      newlyAwarded.push(badgeId);
    }
  };

  // --- Badge Rule Definitions ---

  if (event.type === "account_created") {
    awardBadge("newcomer");
  }

  if (event.type === "chapter_finished") {
    awardBadge("first_step");
  }

  if (event.type === "activity_submitted") {
    // Standard activity completion
    awardBadge("active_learner");

    // Check for flawless execution
    if (event.correctCount === event.totalQuestions && event.totalQuestions > 0) {
      awardBadge("perfect_score");
    }
  }

  if (event.type === "leaderboard_update") {
    // Fetch the top 3 users strictly by points
    const topUsersSnap = await db
      .collection("users")
      .orderBy("totalPoints", "desc")
      .limit(3)
      .get();

    const topUids = topUsersSnap.docs.map(doc => doc.id);
    const userRank = topUids.indexOf(uid);

    if (userRank !== -1) {
      // If they are in the Top 3
      awardBadge("top_3");

      // If they are specifically Number 1
      if (userRank === 0) {
        awardBadge("number_1");
      }
    }
  }

  // --- 4. Database Commit ---
  if (newlyAwarded.length > 0) {
    await userRef.set(
      { badges: Array.from(nextBadges) },
      { merge: true }
    );
  }

  return newlyAwarded;
};