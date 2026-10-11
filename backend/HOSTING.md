# Sharing StudyMate from the laptop

Everything keeps running on the laptop. The backend serves the built frontend, and a Cloudflare
quick tunnel gives that one address a public HTTPS link.

## One-time setup
1. `winget install --id Cloudflare.cloudflared` (then open a new PowerShell window).

## Each time
1. Start Cassandra, the retrieval sidecar (`scripts\run_sidecar.ps1` in StudyMateDb) and, for the
   live comparison only, the Java 21 Cassandra container.
2. In `studymate-backend`: `npm start`.
3. In a second window in `studymate-backend`: `.\host.ps1`
   (use `.\host.ps1 -NoBuild` when the frontend has not changed).
4. Share the `https://<random-words>.trycloudflare.com` link it prints.

The first time, restart the backend after the build finishes: it only looks for the built
frontend at start-up and prints `[server] Frontend: served from ...` when it has found it.

## Things to know
- The link changes every time the tunnel is restarted, and stops when the window is closed or
  the laptop sleeps. Turn off sleep for the demo (Settings > System > Power).
- Anyone with the link can register an account and use the app, which spends the LLM key.
  Share the link only with the people who need it and close the tunnel afterwards.
- Cloudflare cuts any single request after about 100 seconds. Chat, quiz and uploads are well
  inside that; the 20-question self-test in the live comparison may not be when used remotely.
- Development is unchanged: `npm start` in `studymate-frontend` still runs the app on port 3000
  against the backend on port 4000.
