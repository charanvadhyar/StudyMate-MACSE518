# Deploying StudyMate: Railway (cluster, API, retrieval) + Vercel (frontend)

```
 Vercel  ── app pages ──────────────────────────────┐
   │  /api/auth/*  (forwarded, so the sign-in cookie is first-party)
   ▼                                                 ▼ every other /api call, Bearer token
 Railway ── api (Node) ──► retrieval (Python, ColBERT index) ──┐
              │                                               │
              └──────► cassandra-1 ◄──► cassandra-2 ◄──► cassandra-3   (replication factor 3)
```

Everything on Railway talks over Railway's private network (`<service>.railway.internal`).
Only `api` gets a public address. Cassandra and the retrieval service are not reachable from
the internet.

**Cost.** Railway charges about $10 per GB of RAM per month. Three Cassandra nodes (~2 GB each),
the retrieval service (~2–3 GB) and the API (~0.2 GB) come to roughly $2–3 per day while running.
The Hobby plan ($5/month) is enough. Delete the project when you no longer need it (step 9).

Total time: about 45–60 minutes, most of it waiting for builds.

---

## 0. One-time tools and accounts

```powershell
npm install -g @railway/cli
railway login
npx vercel@latest login
```

- Railway: Hobby plan (Settings > Plans).
- Brevo (email; Railway blocks SMTP): sign up at brevo.com, add your Gmail as a sender and
  confirm it (Senders & IP > Senders), then create an API key (SMTP & API > API keys).
  Without it, verification and reset links are printed in the `api` service log instead.

Make two secrets now and keep them for step 4:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(6).toString('hex'))"          # invite code
```

## 1. Create the Railway project

```powershell
cd C:\Users\chara\OneDrive\Desktop\studymate-backend
railway init --name studymate
```

## 2. Three Cassandra nodes

Run these for **cassandra-1** first, then cassandra-2, then cassandra-3:

```powershell
railway add --service cassandra-1 --variables "CASSANDRA_CLUSTER_NAME=StudyMate" --variables "CASSANDRA_DC=datacenter1" --variables "MAX_HEAP_SIZE=1G" --variables "HEAP_NEWSIZE=256M"
railway volume add --mount-path /var/lib/cassandra --service cassandra-1
railway up deploy\cassandra --path-as-root --service cassandra-1 --detach
```

For the other two, add the seed and a start delay (the delay makes them join one at a time):

| service | extra variables |
|---|---|
| cassandra-2 | `SEED_HOST=cassandra-1.railway.internal`, `START_DELAY=60` |
| cassandra-3 | `SEED_HOST=cassandra-1.railway.internal`, `START_DELAY=180` |

```powershell
railway add --service cassandra-2 --variables "CASSANDRA_CLUSTER_NAME=StudyMate" --variables "CASSANDRA_DC=datacenter1" --variables "MAX_HEAP_SIZE=1G" --variables "HEAP_NEWSIZE=256M" --variables "SEED_HOST=cassandra-1.railway.internal" --variables "START_DELAY=60"
railway volume add --mount-path /var/lib/cassandra --service cassandra-2
railway up deploy\cassandra --path-as-root --service cassandra-2 --detach
# same for cassandra-3 with START_DELAY=180
```

If a CLI flag is rejected, do the same in the dashboard: **New > Empty service**, rename it,
add the variables under **Variables**, add a volume at `/var/lib/cassandra` (right-click the
service > **Attach volume**), then run the `railway up` line.

**Check:** after ~5 minutes, open each node's **Deploy Logs**. You want
`[node] ... is the seed` on cassandra-1, and on the others
`joining seed ...` followed by `state jump to NORMAL`. Optionally:
`railway ssh --service cassandra-1` then `nodetool status` should list three `UN` lines.

## 3. Retrieval service

```powershell
railway add --service retrieval --variables "SMDB_CONTACT_POINTS=cassandra-1.railway.internal,cassandra-2.railway.internal,cassandra-3.railway.internal" --variables "SMDB_RF=3" --variables "SMDB_COMPARE_HOSTS=cassandra-1.railway.internal,cassandra-2.railway.internal,cassandra-3.railway.internal" --variables "SMDB_COMPARE_PORT=9042" --variables "PORT=8100"

cd C:\Users\chara\source\repos\StudyMateDb
railway link            # pick the studymate project
powershell -ExecutionPolicy Bypass -File scripts\deploy_sidecar.ps1
```

The script uploads only the code and the newest `data\quantizer_book_*.npz` (no books, no
results). The first build takes ~10 minutes (PyTorch and the two models are baked into the image).
**Check:** its log ends with `Uvicorn running on http://[::]:8100`.

## 4. API

```powershell
cd C:\Users\chara\OneDrive\Desktop\studymate-backend
railway add --service api
```

Set these on `api` (dashboard **Variables > Raw editor** is quickest; paste and fill in):

```
NODE_ENV=production
PORT=4000
TRUST_PROXY=1
JWT_SECRET=<from step 0>
CASSANDRA_CONTACT_POINTS=cassandra-1.railway.internal,cassandra-2.railway.internal,cassandra-3.railway.internal
CASSANDRA_LOCAL_DC=datacenter1
CASSANDRA_KEYSPACE=studymate
CASSANDRA_REPLICATION=datacenter1:3
CASSANDRA_CONSISTENCY=LOCAL_QUORUM
RETRIEVAL_ENABLED=true
RETRIEVAL_URL=http://retrieval.railway.internal:8100
RETRIEVAL_TIMEOUT_MS=20000
LLM_PROVIDER=<same as your local .env>
LLM_API_KEY=<same as your local .env>
LLM_MODEL=<same as your local .env>
REGISTRATION_INVITE_CODE=<from step 0>
REQUIRE_EMAIL_VERIFICATION=true
EMAIL_API_KEY=<Brevo key, or leave empty>
EMAIL_FROM=<the Gmail you verified in Brevo>
APP_URL=https://placeholder.vercel.app
ALLOWED_ORIGINS=https://placeholder.vercel.app
```

```powershell
railway up --service api --detach
railway domain --service api        # prints https://api-production-xxxx.up.railway.app
```

**Check:** open `https://<that address>/api/health`. `cassandra.nodes` should list three nodes
with `"up": true`, and `retrieval` should be reachable.

## 5. Frontend on Vercel

```powershell
cd C:\Users\chara\OneDrive\Desktop\studymate-frontend
powershell -ExecutionPolicy Bypass -File .\deploy-vercel.ps1 -ApiUrl https://api-production-xxxx.up.railway.app
```

Then put the Vercel address it prints into `api`'s variables, replacing the placeholders:
`APP_URL=https://<app>.vercel.app` and `ALLOWED_ORIGINS=https://<app>.vercel.app`.
Railway redeploys `api` by itself when variables change.

## 6. First use

The cluster starts empty. Open the Vercel address, **Create an account** (with the invite code),
open the confirmation link from your email (or from the `api` log), sign in, and upload your
PDFs again. Share the invite code only with people who should be able to sign up.

## 7. Showing the cluster in the review

- `/api/health` lists the three nodes and the consistency level.
- **Take one node down:** Railway > cassandra-3 > the active deployment > **Remove**. Wait ~30 s;
  `/api/health` shows it `"up": false`, and chat, quiz and upload keep working: with three copies
  of every row and LOCAL_QUORUM, two of three replicas answer every read and write.
- **Bring it back:** cassandra-3 > **Redeploy**. It rejoins with its data from the volume and
  Cassandra's hints fill in what it missed.
- Taking down two nodes stops writes (no majority). That is the consistency guarantee working,
  not a fault; worth saying if asked.

## 8. Accounts and sessions (what to say)

- Passwords: bcrypt (cost 12); at least 10 characters, letters and numbers, not common, not
  containing your name or email.
- Sign-in gives a 15-minute access token held in memory only, plus a 30-day refresh token in an
  httpOnly, Secure, SameSite cookie. Only a SHA-256 of the refresh secret is stored, in `sessions`.
- Each refresh swaps the secret with a lightweight transaction (`UPDATE ... IF refresh_hash = ?`);
  a reused old secret ends the session (stolen-cookie detection).
- Logout deletes the session row and takes effect on the next request; "sign out everywhere" and
  password reset delete every session of the user (`sessions_by_user`).
- Email confirmation and reset links are one-time (deleted with `IF EXISTS`), stored hashed, and
  expire by TTL (24 h / 1 h).
- Login throttling: 5 failed attempts per account in 15 minutes (`login_failures`, rows expire by
  TTL, so the partition count is the recent-failure count), plus per-address limits on every
  auth route. Registration needs the invite code.

## 9. Tear down

Railway > project **studymate** > Settings > **Delete project**. Vercel > project > Settings >
**Delete**. Your laptop setup is unchanged and keeps working.

## Local rehearsal of the cluster (optional)

```powershell
docker compose -f deploy\cassandra\docker-compose.cluster.yml up -d --build
docker exec cluster-cassandra-1 nodetool status
```

Same image and start-up script, three nodes, CQL on `localhost:9045`.
