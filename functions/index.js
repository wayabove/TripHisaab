const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const APP_URL = "https://trip-expense-tracker-daea7.web.app";
const INVALID_TOKEN_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered"
]);

function stringValue(value) {
  return value == null ? "" : String(value);
}

function notificationBody(notification) {
  if (notification.message) return String(notification.message);
  const actor = notification.actorName || notification.fromMemberName || "Someone";
  const action = notification.action || "updated the trip";
  return `${actor} ${action}.`;
}

exports.sendTripNotificationPush = onDocumentCreated(
  "trips/{tripId}/notifications/{notificationId}",
  async event => {
    const snapshot = event.data;
    if (!snapshot) return;

    const { tripId, notificationId } = event.params;
    const notification = snapshot.data();

    if (notification.pushDisabled === true || notification.isPrivate === true) return;
    if (!notification.recipientMemberId) return;

    const memberRef = db.doc(`trips/${tripId}/members/${notification.recipientMemberId}`);
    const memberSnap = await memberRef.get();
    const recipientUserId = memberSnap.get("userId");

    if (!recipientUserId) {
      await snapshot.ref.set(
        {
          pushStatus: "skipped",
          pushSkippedReason: "recipient has no linked user id",
          pushUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      return;
    }

    const tokensSnap = await db
      .collection(`users/${recipientUserId}/notificationTokens`)
      .where("status", "==", "active")
      .get();
    const tokenDocs = tokensSnap.docs
      .map(doc => ({ ref: doc.ref, token: doc.get("token") }))
      .filter(entry => typeof entry.token === "string" && entry.token.length > 0);

    if (tokenDocs.length === 0) {
      await snapshot.ref.set(
        {
          pushStatus: "skipped",
          pushSkippedReason: "recipient has no active tokens",
          pushUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      return;
    }

    const title = notification.tripName || "TripHisaab";
    const body = notificationBody(notification);
    const response = await admin.messaging().sendEachForMulticast({
      tokens: tokenDocs.map(entry => entry.token),
      notification: { title, body },
      data: {
        title,
        body,
        tripId,
        notificationId,
        type: stringValue(notification.type),
        entityId: stringValue(notification.entityId),
        action: stringValue(notification.action)
      },
      webpush: {
        fcmOptions: {
          link: APP_URL
        },
        notification: {
          icon: `${APP_URL}/appIcon-192.png`,
          badge: `${APP_URL}/appIcon-192.png`,
          tag: notificationId
        }
      }
    });

    const cleanupWrites = [];
    response.responses.forEach((result, index) => {
      const code = result.error?.code;
      if (code && INVALID_TOKEN_CODES.has(code)) {
        cleanupWrites.push(
          tokenDocs[index].ref.set(
            {
              status: "disabled",
              disabledAt: admin.firestore.FieldValue.serverTimestamp(),
              disabledReason: code
            },
            { merge: true }
          )
        );
      }
    });
    await Promise.all(cleanupWrites);

    await snapshot.ref.set(
      {
        pushStatus: response.failureCount > 0 ? "partial" : "sent",
        pushSuccessCount: response.successCount,
        pushFailureCount: response.failureCount,
        pushUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    logger.info("Trip notification push processed", {
      tripId,
      notificationId,
      recipientUserId,
      successCount: response.successCount,
      failureCount: response.failureCount
    });
  }
);
