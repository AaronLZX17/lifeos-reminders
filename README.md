# lifeos-reminders

Scheduled sender for [Life OS](https://lifeosiuu.web.app) push reminders.
Every 5 minutes a GitHub Action checks upcoming timed events in Firestore and
sends a web-push notification ~0–20 minutes before each one starts.

Contains no personal data; credentials live in the repo secret
`FIREBASE_SERVICE_ACCOUNT`. Public so scheduled minutes are unlimited.
