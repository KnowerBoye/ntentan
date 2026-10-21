// ─────────────────────────────────────────────
//  features/medical-alert/medical-alert.service.ts
// ─────────────────────────────────────────────
import { getFirestore } from "@lib/firebase";
import { logger } from "@lib/logger";

// ── Types ────────────────────────────────────
export interface EmergencyContact {
  name: string;
  phoneNumber: string;
  relationship: string;
}

export interface MedicalAlertResult {
  notified_contacts: Array<{
    name: string;
    phoneNumber: string;
    success: boolean;
  }>;
}

interface MNotifySendResponse {
  status: string;
  code: string;
  message: string;
  summary: {
    _id: string;
    message_id: string;
    type: string;
    total_sent: number;
    contacts: number;
    total_rejected: number;
    numbers_sent: string[];
    credit_used: number;
    credit_left: number;
  };
}

// ── SMS sender using fetch (mNotify API) ─────
export async function sendEmergencySms(
  phoneNumber: string,
  message: string
): Promise<boolean> {
  const apiKey = process.env.MNOTIFY_API_KEY;
  if (!apiKey) {
    logger.error("[SMS] MNOTIFY_API_KEY is not configured");
    return false;
  }

  const sender = process.env.MNOTIFY_SENDER_ID || "Ntentan";

  logger.info("[SMS] Sending emergency SMS via mNotify", {
    to: phoneNumber,
    sender,
  });

  try {
    const url = new URL("https://api.mnotify.com/api/sms/quick");
    url.searchParams.set("key", apiKey);

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: [phoneNumber],
        sender,
        message,
      }),
    });

    const data: MNotifySendResponse = await response.json();

    if (!response.ok) {
      logger.error("[SMS] mNotify API returned error", {
        status: response.status,
        statusText: response.statusText,
      });
      return false;
    }

    



    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error("[SMS] Failed to send via mNotify", { error: message });
    return false;
  }
}

// ── Build Google Maps link ──────────────────
function buildGoogleMapsLink(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

// ── Build SMS message text ──────────────────
function buildEmergencySmsText(
  userName: string,
  mapLink: string,
  contactName: string
): string {
  return [
    `🚨 EMERGENCY ALERT from ${userName}`,
    `Location: ${mapLink}`,
    `Please respond immediately!`,
  ].join("\n");
}

// ── Main alert handler ──────────────────────
export async function handleMedicalAlert(
  userId: string,
  latitude: number,
  longitude: number
): Promise<MedicalAlertResult> {
  const db = getFirestore();

  // 1. Fetch user document from Firestore
  const userDoc = await db.collection("users").doc(userId).get();

  if (!userDoc.exists) {
    throw new Error("User not found");
  }

  const userData = userDoc.data()!;
  const userName = userData.userName ?? "Unknown User";
  const emergencyConfig = userData.emergencyConfig;

  // 2. Validate emergency config exists and has contacts
  if (!emergencyConfig) {
    throw new Error("No emergency configuration found on user profile");
  }

  const contacts: EmergencyContact[] = emergencyConfig.contacts ?? [];

  if (contacts.length === 0) {
    throw new Error("No emergency contacts configured");
  }

  // 3. Build the Google Maps link
  const mapLink = buildGoogleMapsLink(latitude, longitude);

  // 4. Send SMS to each contact
  const results: MedicalAlertResult["notified_contacts"] = [];

  for (const contact of contacts) {
    const message = buildEmergencySmsText(userName, mapLink, contact.name);
    const success = await sendEmergencySms(contact.phoneNumber, message);

    results.push({
      name: contact.name,
      phoneNumber: contact.phoneNumber,
      success,
    });
  }

  logger.info("Medical alert processed", {
    userId,
    latitude,
    longitude,
    contactsNotified: results.length,
    allSuccessful: results.every((r) => r.success),
  });

  return { notified_contacts: results };
}