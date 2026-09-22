# Running on macOS

The code is cross-platform — nothing in `backend/` or `sim/` is Windows-only. The only
things that change are the `GOOGLE_APPLICATION_CREDENTIALS` path style and the
"kill a stuck server" command.

## 1. Node

```bash
brew install node
node -v            # 18+
```

## 2. Install

```bash
git clone <repo-url> hackathon
cd hackathon/backend
npm install        # only backend has dependencies; sim/ has none
```

## 3. Secret files — copy by hand

These are gitignored, so a clone does not bring them:

| File | Needed for |
|---|---|
| `backend/.env` | port + Firebase path |
| `backend/serviceAccountKey.json` | Firebase Admin — optional |
| `android/app/google-services.json` | Android build only |

**Firebase is optional.** Leave `GOOGLE_APPLICATION_CREDENTIALS` unset and the engine
loads `credentials.json` from disk; every scenario still works offline.

## 4. Fix the path in `.env`

`.env.example` shows a Windows path. On macOS use a POSIX absolute path:

```bash
PORT=8000

# Windows was: D:\hackathon\backend\serviceAccountKey.json
GOOGLE_APPLICATION_CREDENTIALS=/Users/you/hackathon/backend/serviceAccountKey.json
```

Comment that line out to run fully offline.

## 5. Run

```bash
cd backend && node server.js
```

Open **http://localhost:8000**.

## 6. Verify — steps 1–4 need no Firebase and no phone

```bash
cd backend && node graph.js        # D-LOBBY -> D-SERVER must be 110s
cd sim && node attack.js           # ANOMALY / CLONED_CREDENTIAL, ~27x
cd sim && node attack.js --steal   # CREDENTIAL_SHARED_OR_STOLEN
cd sim && node normal.js           # leave running: ZERO anomalies
```

Full list is in `CLAUDE.md` under **No test framework**.

## Stuck server / `EADDRINUSE`

`CLAUDE.md` gives a PowerShell command for this. The macOS equivalent:

```bash
lsof -ti:8000 | xargs kill -9
```

## Android on macOS

```bash
brew install --cask temurin@21          # JDK 21
cd android && ./gradlew assembleDebug
```

`android/local.properties` (gitignored) needs the Mac SDK path:

```properties
sdk.dir=/Users/you/Library/Android/sdk
```

The build fails without `android/app/google-services.json`.
