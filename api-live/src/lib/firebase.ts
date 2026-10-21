// ─────────────────────────────────────────────
//  lib/firebase.ts  –  Firebase Admin singleton
// ─────────────────────────────────────────────
import * as admin from "firebase-admin/app";
import * as firestore from "firebase-admin/firestore";
import * as dotenv from "dotenv";
import path from "path";


dotenv.config();


const serviceAccount = require(
  path.resolve(process.cwd(), process.env.FIREBASE_CREDENTIALS!)
);

admin.initializeApp({
  credential : admin.cert(
    serviceAccount
  )
})

let _db: firestore.Firestore | null = null;

export function getFirestore(): firestore.Firestore {
  if (_db) return _db;

  _db = firestore.getFirestore();
  return _db;
}


export const Collections = {
  USERS: "users",
  PRESCRIPTIONS: "medications",  
} as const;