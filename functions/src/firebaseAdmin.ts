import {cert, getApps, initializeApp} from "firebase-admin/app";
import {getFirestore, Timestamp} from "firebase-admin/firestore";

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

if (getApps().length === 0) {
  if (clientEmail && privateKey && projectId) {
    initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
      projectId,
    });
  } else {
    initializeApp();
  }
}

export const adminDb = getFirestore();

export const normalizeFirestoreData = (value: unknown): unknown => {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeFirestoreData(item));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, nestedValue]) => [key, normalizeFirestoreData(nestedValue)]
    );
    return Object.fromEntries(entries);
  }

  return value;
};

export const mapDoc = (docSnap: FirebaseFirestore.QueryDocumentSnapshot) => ({
  id: docSnap.id,
  ...(normalizeFirestoreData(docSnap.data()) as Record<string, unknown>),
});
