# Impossible Travel — Android operator app

Live red-alert feed + one-tap revoke, over Firestore. Two features, nothing else:
no amber review queue, no stats header, no door map, no login.

**The app never learns the backend's address.** It reads and writes Firebase; the
backend does the same from the other side. That is why there is no WebSocket here
and why the phone works on mobile data with no venue wifi.

```
phone ──listen──► anomalies/                 ◄──write── backend (Admin SDK)
phone ──write───► credentials/{id}.revoked=true
                       │
                       └──onSnapshot──► backend rebuilds registry ──► next scan DENY
phone ◄──push──── FCM topic "anomalies"      ◄──send── backend
```

## Build status

Compiles and packages clean against JDK 21 / AGP 8.7.3 / Kotlin 2.0.21 / Gradle 8.10.
It will **not** build until you supply a real `app/google-services.json` (step 2).

## Setup — three manual steps, then it runs

### 1. Firebase project

Console → new project → Firestore in **Native mode**.

Project settings → Service accounts → Generate new private key → save as
`backend/serviceAccountKey.json` (gitignored).

In `backend/.env`:

```
GOOGLE_APPLICATION_CREDENTIALS=D:\hackathon\backend\serviceAccountKey.json
```

Then seed. **Do not skip this** — see *The seeding trap* below.

```bash
cd backend && npm run seed
```

Expect 10 doors and 15 credentials, both visible in the console.

### 2. Register the Android app

Firebase console → Add app → Android → package name **exactly**
`com.allegion.anomaly` (this must match `applicationId` in `app/build.gradle.kts`).

Download `google-services.json` into `android/app/`. It is gitignored — share it
over team chat, never commit it. `app/google-services.json.template` shows the
expected shape; it is a dead placeholder, not usable.

### 3. Publish the security rules

Paste `firestore.rules` into Firebase console → Firestore → Rules → **Publish**.

Do not use the console's "test mode" rules instead — those carry a 30-day
`request.time` expiry that silently empties the feed weeks later.

## Run it

```bash
cd android && ./gradlew installDebug
```

Or open `android/` in Android Studio and hit Run. Accept the notification
permission prompt on first launch, or push will be silently dropped.

## The seeding trap

`store.loadCredentials` (`backend/store.js:98`) replaces the entire registry from
every Firestore snapshot and refuses only a **zero-length** list.

If the `credentials` collection was never seeded and the phone writes
`{revoked: true}` with merge, Firestore **creates** the document, the backend's
watcher fires with a one-element list, and the registry becomes one garbage
credential. Every later scan returns `UNKNOWN_CREDENTIAL` and detection dies
silently, mid-demo.

Two independent guards, both already in place:
- run `npm run seed` before the phone ever writes
- `allow create: if false` on `credentials` in `firestore.rules` — a merge-set onto
  a missing doc counts as a *create*, so this blocks it at the source

## Files

| File | Purpose |
|---|---|
| `Models.kt` | `Anomaly` + `Leg`, and a defensive `toAnomaly()` mapper |
| `AnomalyRepository.kt` | The only Firestore contact: two listeners, one fetch, one write |
| `AnomalyViewModel.kt` | Combines three flows into `UiState`; holds the notification highlight |
| `MainActivity.kt` | Permission prompt, topic subscribe, notification-tap handling |
| `AlertList.kt` | `AlertScreen` + `AlertCard`, mirroring `backend/public/index.html:368` |
| `AnomalyMessagingService.kt` | HIGH-importance channel + foreground banner |
| `firestore.rules` | Reference copy of what you pasted into the console |

## Things that will bite you

- **`orderBy("created_at")` silently drops documents missing that field.** The
  backend always sets it, but a hand-made test doc in the console will not appear.
  Check this first if a doc exists in Firestore but not on screen.
- **A force-stopped app receives no pushes** until you relaunch it manually.
- **Backgrounded, `onMessageReceived` is not called.** The system tray renders the
  notification payload itself — that is what makes tap-to-open free. Foreground is
  the inverse, which is what `AnomalyMessagingService` is for.
- **Test push before you revoke anything.** Once `B-4471` is dead, `attack.js`
  halts at scan 1 and never produces a second anomaly to push.
- **Numbers cross the JS/Kotlin boundary as `Number`, not `Double`.** Node sends
  `27.4` as a double but an integral `27` as an int64. That is why `Models.kt`
  maps by hand instead of using `toObject<Anomaly>()`.

## Known boundaries — say these before judges ask

- **Reads are unauthenticated.** Anyone with the project ID can read the alert
  feed; anyone with the APK can revoke. The rules limit blast radius to flipping
  one boolean in one direction — no field injection, no un-revoke, no delete.
  Production needs Firebase Auth with an operator claim, and revoke routed through
  a privileged function so the phone never writes the registry at all.
- **Push goes to a topic, not device tokens.** Anyone who installs the APK gets
  the alerts. Tokens would need a `devices` collection and a fan-out loop.
- **Push depends on the backend process being alive.** Already true of the whole
  demo — no backend, no anomalies. The architecture rule is untouched: the backend
  gained an *outbound* call to Google, not an inbound one from the phone.
