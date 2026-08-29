// Life OS reminder sender — runs on a GitHub Actions schedule.
// Per-user preferences (users/{uid}.remind):
//   lead      minutes before a timed event to start reminding (default 15)
//   every     re-remind interval in minutes until the event starts (0 = once)
//   wake      "HH:MM" — morning digest of the whole day (empty = off)
//   wakeEvery digest repeat interval (0 = once; repeats capped at 3 sends)
// No personal data is ever logged: action logs on this public repo are public.
import admin from "firebase-admin";

const key = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const TZ = "Asia/Kuala_Lumpur";
const now = new Date();
const parts = Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
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

let sends = 0;
async function sendTo(tokens, title, body, updates){
  for (const token of tokens){
    try {
      await admin.messaging().send({
        token,
        webpush: {
          notification: { title, body, icon: "https://lifeosiuu.web.app/icon-192.png" },
          fcmOptions: { link: "https://lifeosiuu.web.app/" },
        },
      });
      sends++;
    } catch (err){
      if (String(err.code).includes("registration-token-not-registered"))
        updates[`tokens.${token}`] = admin.firestore.FieldValue.delete();
      else console.error("send failed:", err.code || err.message);
    }
  }
}

const pushDocs = await db.collection("push").get();
for (const doc of pushDocs.docs){
  const uid = doc.id;
  const tokens = Object.keys(doc.data().tokens || {});
  if (!tokens.length) continue;
  const sent = doc.data().sent || {};
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) continue;
  const st = userSnap.data();
  const r = st.remind || {};
  const lead = +r.lead || 15, every = +r.every || 0;
  const wake = typeof r.wake === "string" ? r.wake : "";
  const wakeEvery = +r.wakeEvery || 0;

  const events = (st.events || []).filter(occursToday)
    .sort((a, b) => (a.time || "") < (b.time || "") ? -1 : 1);
  const updates = {};

  // per-event reminders: first at `lead` minutes out, then every `every` minutes
  for (const ev of events){
    if (!ev.time) continue;
    const startMin = (+ev.time.slice(0, 2)) * 60 + (+ev.time.slice(3, 5));
    const delta = startMin - nowMin;
    if (delta <= 0 || delta > lead) continue;
    const slot = every > 0 ? Math.floor((lead - delta) / every) : 0;
    const dedupe = `${ev.id}:${todayStr}:${slot}`;
    if (sent[dedupe]) continue;
    const when = delta >= 60 ? `in ${Math.round(delta / 60)}h ${delta % 60}m` : `in ${delta} min`;
    await sendTo(tokens, ev.title,
      `Starts ${when} — at ${t12(ev.time)}` + (ev.end ? ` (until ${t12(ev.end)})` : ""), updates);
    updates[`sent.${dedupe}`] = Date.now();
  }

  // wake-up digest: everything on today, at the chosen time (repeats capped at 3)
  if (wake && events.length){
    const wakeMin = (+wake.slice(0, 2)) * 60 + (+wake.slice(3, 5));
    const d2 = nowMin - wakeMin;
    if (d2 >= 0){
      const slot = wakeEvery > 0 ? Math.floor(d2 / wakeEvery) : 0;
      const inWindow = wakeEvery > 0 ? slot <= 2 : d2 <= 60;
      const dedupe = `digest:${todayStr}:${slot}`;
      if (inWindow && !sent[dedupe]){
        const list = events.slice(0, 6)
          .map(e => (e.time ? t12(e.time) + " " : "") + e.title).join("  ·  ");
        await sendTo(tokens,
          `Today: ${events.length} event${events.length === 1 ? "" : "s"}`,
          list + (events.length > 6 ? " …" : ""), updates);
        updates[`sent.${dedupe}`] = Date.now();
      }
    }
  }

  // prune old dedupe entries
  const cutoff = Date.now() - 2 * 864e5;
  for (const [k, v] of Object.entries(sent)) if (v < cutoff) updates[`sent.${k}`] = admin.firestore.FieldValue.delete();
  if (Object.keys(updates).length) await doc.ref.update(updates);
}
console.log(`done ${todayStr} ${parts.hour}:${parts.minute}, notifications sent: ${sends}`);
process.exit(0);
