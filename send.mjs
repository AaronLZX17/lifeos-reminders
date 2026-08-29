// Life OS reminder sender — runs on a GitHub Actions schedule.
// Reads each user's events from Firestore and pushes a notification
// shortly before a timed event starts. No personal data lives in this repo.
import admin from "firebase-admin";

const key = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const TZ = "Asia/Kuala_Lumpur";
const LEAD_MAX = 20;            // notify when an event starts within this many minutes

const now = new Date();
const parts = Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
  .formatToParts(now).map(p => [p.type, p.value]));
const todayStr = `${parts.year}-${parts.month}-${parts.day}`;
const nowMin = (+parts.hour) * 60 + (+parts.minute);
const localDate = new Date(+parts.year, +parts.month - 1, +parts.day);
const dowM = (localDate.getDay() + 6) % 7;

function occursToday(ev){
  if (ev.skip && ev.skip.includes(todayStr)) return false;
  if (ev.repeat && ev.repeat !== "none" && ev.until && todayStr > ev.until) return false;
  if (ev.repeat === "weekly")  return todayStr >= ev.date && ev.day === dowM;
  if (ev.repeat === "monthly") return todayStr >= ev.date && ev.dom === localDate.getDate();
  if (ev.repeat === "daily")   return todayStr >= ev.date;
  return ev.date === todayStr;
}
function t12(t){
  const h = +t.slice(0, 2), m = t.slice(3, 5);
  let hh = h % 12; if (hh === 0) hh = 12;
  return hh + (m !== "00" ? ":" + m : "") + (h < 12 ? "am" : "pm");
}

const pushDocs = await db.collection("push").get();
for (const doc of pushDocs.docs){
  const uid = doc.id;
  const tokens = Object.keys(doc.data().tokens || {});
  if (!tokens.length) continue;
  const sent = doc.data().sent || {};
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) continue;
  const events = (userSnap.data().events || []).filter(e => e.time && occursToday(e));

  const updates = {};
  for (const ev of events){
    const startMin = (+ev.time.slice(0, 2)) * 60 + (+ev.time.slice(3, 5));
    const delta = startMin - nowMin;
    if (delta <= 0 || delta > LEAD_MAX) continue;
    const dedupe = `${ev.id}:${todayStr}`;
    if (sent[dedupe]) continue;
    for (const token of tokens){
      try {
        await admin.messaging().send({
          token,
          webpush: {
            notification: {
              title: ev.title,
              body: `Starts at ${t12(ev.time)}` + (ev.end ? ` (until ${t12(ev.end)})` : ""),
              icon: "https://lifeosiuu.web.app/icon-192.png",
            },
            fcmOptions: { link: "https://lifeosiuu.web.app/" },
          },
        });
        console.log(`sent: ${uid.slice(0, 6)}… ${ev.title} in ${delta}m`);
      } catch (err){
        if (String(err.code).includes("registration-token-not-registered"))
          updates[`tokens.${token}`] = admin.firestore.FieldValue.delete();
        else console.error("send failed:", err.code || err.message);
      }
    }
    updates[`sent.${dedupe}`] = Date.now();
  }
  // prune old dedupe entries
  const cutoff = Date.now() - 2 * 864e5;
  for (const [k, v] of Object.entries(sent)) if (v < cutoff) updates[`sent.${k}`] = admin.firestore.FieldValue.delete();
  if (Object.keys(updates).length) await doc.ref.update(updates);
}
console.log("done", todayStr, `${parts.hour}:${parts.minute}`);
process.exit(0);
