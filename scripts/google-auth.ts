/**
 * One-time helper: run Google's OAuth flow locally and print a refresh token.
 *
 *   1. Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (OAuth client type "Desktop app") in .env.local
 *   2. pnpm google:auth
 *   3. Open the printed URL, allow access, copy GOOGLE_REFRESH_TOKEN into .env.local
 *
 * Uses a loopback redirect (http://127.0.0.1:<port>) + PKCE, which Desktop-app clients allow
 * without registering redirect URIs. Scopes: create events + read free/busy and calendar info.
 */
import "./load-env";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const port = Number(process.env.GOOGLE_OAUTH_PORT) || 53682;

if (!clientId || !clientSecret) {
  console.error(
    "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local first (see README → Google Calendar).",
  );
  process.exit(1);
}

const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
const state = randomBytes(16).toString("hex");
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: SCOPES.join(" "),
  access_type: "offline", // → refresh token
  prompt: "consent", // always return a refresh token, even on re-authorization
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();

const timeout = setTimeout(() => {
  console.error("\nTimed out after 5 minutes without a callback.");
  process.exit(1);
}, 5 * 60_000);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri);
  if (url.pathname !== "/oauth2callback") {
    res.writeHead(404).end();
    return;
  }
  const finish = (status: number, message: string) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<body style="font-family:system-ui;padding:2rem"><h2>${message}</h2><p>You can close this tab.</p></body>`,
    );
  };

  if (url.searchParams.get("state") !== state) return finish(400, "State mismatch — please retry.");
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (error || !code) {
    finish(400, `Authorization failed: ${error ?? "no code"}`);
    console.error(`\nAuthorization failed: ${error ?? "no code"}`);
    process.exit(1);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: code!,
      client_id: clientId!,
      client_secret: clientSecret!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }).toString(),
  });
  const tokens = (await tokenRes.json()) as {
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !tokens.refresh_token) {
    finish(500, "Token exchange failed — see the terminal.");
    console.error(
      "\nToken exchange failed:",
      tokens.error_description ?? tokens.error ?? tokenRes.status,
    );
    console.error(
      "If no refresh_token was returned, remove the app's access at https://myaccount.google.com/permissions and retry.",
    );
    process.exit(1);
  }

  finish(200, "✅ LeadPilot is connected to Google Calendar");
  console.log("\n✔ Success! Add this line to .env.local (and to your Vercel env vars):\n");
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  console.log('⚠ If your OAuth consent screen is in "Testing" mode, this token expires in 7 days.');
  console.log(
    '  Publish the app ("In production") to get long-lived tokens — see README → Google Calendar.\n',
  );
  clearTimeout(timeout);
  server.close();
  process.exit(0);
});

server.listen(port, "127.0.0.1", () => {
  console.log("Open this URL in your browser and allow access:\n");
  console.log(authUrl.toString());
  console.log(`\nWaiting for Google to redirect to ${redirectUri} …`);
});
