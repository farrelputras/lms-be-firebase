import {cert, getApps, initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {getFirestore, Timestamp} from "firebase-admin/firestore";
import {getStorage} from "firebase-admin/storage";

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;

if (getApps().length === 0) {
  if (clientEmail && privateKey && projectId) {
    initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
      projectId,
      storageBucket,
    });
  } else {
    initializeApp();
  }
}

export const adminDb = getFirestore();
export const adminAuth = getAuth();
export const adminStorage = getStorage();

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
