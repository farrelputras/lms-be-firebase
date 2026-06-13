// Bulk-register users through the real registration flow (POST /v1/auth/register),
// and optionally set their chatbot access in the same pass.
//
// Registration goes through Firebase Auth (createUser) + custom claims + Firestore
// + badge, exactly like the UI's signup step 1 — so accounts are fully functional
// for login. The register endpoint does NOT accept a chatbot flag, so chatbot
// access is written straight to users/{uid} via the Admin SDK after each register.
//
// Because of that Admin SDK write, this script now needs (like the other *.mjs):
//   1. npm run build              # so lib/ is current — we import lib/firebaseAdmin.js
//   2. .env creds (PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY) for the SAME project API_BASE points at
//
// Usage (PowerShell), from lms-be-firebase/functions/ :
//   $env:API_BASE = "https://us-central1-<project>.cloudfunctions.net/api/v1"   # deployed
//   # or emulator: "http://127.0.0.1:5001/<PROJECT_ID>/us-central1/api/v1"
//   node scripts/registerUsers.mjs scripts/users.json
//
// users.json format:
//   [{ "name": "Siti", "email": "siti@example.com", "password": "secret123", "chatbot_access": true }, ...]
//   - "password" omitted        -> DEFAULT_PASSWORD
//   - "name" omitted            -> email prefix
//   - "chatbot" present         -> written to users/{uid} (true grants, false revokes)

import "dotenv/config";
import { adminDb } from "../lib/firebaseAdmin.js";
import { readFile } from "node:fs/promises";

const API_BASE = process.env.API_BASE;
const DEFAULT_PASSWORD = "abc123";

if (!API_BASE) {
  console.error("✗ Set API_BASE first, e.g.\n  $env:API_BASE = \"http://127.0.0.1:5001/<PROJECT_ID>/us-central1/api/v1\"");
  process.exit(1);
}

const file = process.argv[2] || "scripts/groboganUsers.json";
const users = JSON.parse(await readFile(file, "utf8"));

let ok = 0;
let skipped = 0;
let failed = 0;
let chatbotSet = 0;

// Per-row chatbot flag — accepts either key. Returns true/false, or undefined
// when neither key is present (in which case we leave access at the default).
function readChatbotFlag(row) {
  if (typeof row.chatbot === "boolean") return row.chatbot;
  return false;
}

// Resolve a uid for an email from the users collection (used when the account
// already exists, so the register response carried no uid).
async function uidForEmail(email) {
  const snap = await adminDb.collection("users").where("email", "==", email).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

async function applyChatbot(uid, email, flag) {
  if (flag === undefined || !uid) return;
  try {
    await adminDb.collection("users").doc(uid).update({ chatbotEnabled: flag });
    chatbotSet++;
    console.log(`   ↳ chatbotEnabled=${flag}`);
  } catch (err) {
    console.error(`   ↳ ✗ failed to set chatbotEnabled for ${email}: ${err.message}`);
  }
}

for (const u of users) {
  const email = u.email?.trim();
  if (!email) {
    console.warn("⊘ row missing email, skipping:", JSON.stringify(u));
    failed++;
    continue;
  }
  const flag = readChatbotFlag(u);
  const body = {
    name: u.name || email.split("@")[0],
    email,
    password: u.password || DEFAULT_PASSWORD,
  };

  try {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));

    if (res.ok) {
      ok++;
      const uid = json?.data?.uid;
      console.log(`✓ ${email}  (uid: ${uid ?? "?"})`);
      await applyChatbot(uid, email, flag);
    } else {
      const msg = json?.error?.message || `HTTP ${res.status}`;
      // Already-registered emails come back as REGISTER_FAILED "...email already exists".
      if (/already exists/i.test(msg)) {
        skipped++;
        console.log(`↻ ${email}  (already exists, skipped)`);
        // Still honor the flag on re-runs by looking the uid up.
        if (flag !== undefined) await applyChatbot(await uidForEmail(email), email, flag);
      } else {
        failed++;
        console.error(`✗ ${email}  ${msg}`);
      }
    }
  } catch (err) {
    failed++;
    console.error(`✗ ${email}  ${err.message}`);
  }
}

console.log(`\nDone. created=${ok} skipped=${skipped} failed=${failed} chatbotSet=${chatbotSet}`);
process.exit(0);
