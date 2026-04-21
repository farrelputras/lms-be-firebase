import {cert, getApps, initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {getFirestore} from "firebase-admin/firestore";
import {getStorage} from "firebase-admin/storage";

const projectId = process.env.PROJECT_ID;
const clientEmail = process.env.CLIENT_EMAIL;
const privateKey = process.env.PRIVATE_KEY?.replace(/\\n/g, "\n");
const storageBucket = process.env.STORAGE_BUCKET;

if (getApps().length === 0) {
  if (clientEmail && privateKey && projectId && storageBucket) {
    initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
      projectId,
      storageBucket,
    });
  } else {
    // For Cloud Run with ADC — still pass storageBucket explicitly
    initializeApp({
      storageBucket: storageBucket ?? `${projectId}.appspot.com`,
    });
  }
}

export const adminDb = getFirestore();
export const adminAuth = getAuth();
export const adminStorage = getStorage();

export const normalizeFirestoreData = (value: unknown): unknown => {
  // 1. Handle Null/Undefined immediately
  if (value === null || value === undefined) return value;

  // 2. Robust Timestamp Check (Better than instanceof)
  if (typeof value === 'object' && value !== null && 'toDate' in value && typeof (value as any).toDate === 'function') {
    return (value as any).toDate().toISOString();
  }

  // 3. Date Check
  if (value instanceof Date) {
    return value.toISOString();
  }

  // 4. Array Check
  if (Array.isArray(value)) {
    return value.map((item) => normalizeFirestoreData(item));
  }

  // 5. Plain Object Check (Avoid recursing on class instances/internal types)
  if (typeof value === "object" && value.constructor.name === 'Object') {
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

