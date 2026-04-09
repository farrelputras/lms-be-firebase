import {Firestore} from "firebase-admin/firestore";

type BadgeEvent =
  | {
    type: "quiz_submit";
    correctCount: number;
    totalQuestions: number;
  }
  | {
    type: "points_update";
  }
  | {
    type: "activity_submitted";
    activityType: string;
    earnedPoints: number;
    maxPoints: number;
  }
  | {
    type: "activity_perfect";
    activityType: string;
    maxPoints: number;
  };

export const checkAndAwardBadges = async (
  uid: string,
  db: Firestore,
  event: BadgeEvent
): Promise<string[]> => {
  if (event.type === "activity_submitted") {
    // TODO: implement activity submission badge rules
    return [];
  }

  if (event.type === "activity_perfect") {
    // TODO: implement perfect score badge rules
    return [];
  }

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();

  const currentBadges = Array.isArray(userSnap.data()?.badges) ?
    (userSnap.data()?.badges as string[]) :
    [];

  const nextBadges = new Set(currentBadges);
  const newlyAwarded: string[] = [];

  // Award perfect score on flawless quiz submission.
  if (
    event.type === "quiz_submit" &&
    event.correctCount === event.totalQuestions &&
    !nextBadges.has("perfect_score")
  ) {
    nextBadges.add("perfect_score");
    newlyAwarded.push("perfect_score");
  }

  const topUsersSnap = await db
    .collection("users")
    .orderBy("totalPoints", "desc")
    .limit(3)
    .get();

  const isTop3 = topUsersSnap.docs.some((docSnap) => docSnap.id === uid);
  if (isTop3 && !nextBadges.has("top_3")) {
    nextBadges.add("top_3");
    newlyAwarded.push("top_3");
  }

  if (newlyAwarded.length > 0) {
    await userRef.set({badges: Array.from(nextBadges)}, {merge: true});
  }

  return newlyAwarded;
};
