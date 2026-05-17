import { getMessaging, getToken, isSupported, onMessage } from "firebase/messaging";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { app, db } from "./firebase";

const FIREBASE_VAPID_KEY =
  import.meta.env.VITE_FIREBASE_VAPID_KEY ||
  "BIc_3w3d-Briuk2eydFFT54ih8RuRTvbrAtmuIyife9vqq-fBwPo0Ar7axtQbqMzlbiMed_zFTYyBFDUfuT3y6k";

let messagingPromise;

async function getSupportedMessaging() {
  if (!messagingPromise) {
    messagingPromise = isSupported()
      .then(supported => (supported ? getMessaging(app) : null))
      .catch(() => null);
  }
  return messagingPromise;
}

function getTokenDocId(token) {
  return encodeURIComponent(token).replace(/\./g, "%2E");
}

export async function registerPushTokenForUser(user) {
  if (!user || typeof window === "undefined") return { status: "signed-out" };
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    return { status: "unsupported" };
  }
  if (Notification.permission !== "granted") {
    return { status: Notification.permission || "default" };
  }

  const messaging = await getSupportedMessaging();
  if (!messaging) return { status: "unsupported" };

  const serviceWorkerRegistration = await navigator.serviceWorker.ready;
  const token = await getToken(messaging, {
    vapidKey: FIREBASE_VAPID_KEY,
    serviceWorkerRegistration
  });

  if (!token) return { status: "unavailable" };

  await setDoc(
    doc(db, "users", user.uid, "notificationTokens", getTokenDocId(token)),
    {
      token,
      platform: "web",
      status: "active",
      userAgent: navigator.userAgent || "",
      appVersion: "2.1.0",
      updatedAt: serverTimestamp(),
      lastSeenAt: serverTimestamp()
    },
    { merge: true }
  );

  return { status: "registered", token };
}

export async function subscribeToForegroundPushMessages(handler) {
  if (typeof window === "undefined") return () => {};
  const messaging = await getSupportedMessaging();
  if (!messaging) return () => {};
  return onMessage(messaging, handler);
}
