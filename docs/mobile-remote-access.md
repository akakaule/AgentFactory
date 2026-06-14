# Mobile / remote access (local board on your phone)

Reach the local AgentFactory board (`:8787`) from a phone — to follow status, review, and
queue work — without deploying to the cloud. Execution (the dispatcher, agents, git) stays on
your workstation exactly as today; only the board's HTTP surface is reached remotely.

> **Auth is a hard prerequisite the moment the board leaves `localhost`.** The board has
> destructive actions (approve, request changes, reopen, delete, queue work that runs agents).
> A tunnel authenticates the *device/connection*, not the *person*, so the board must run in
> token mode. Never expose `AUTH_MODE=none` beyond localhost.

## 1. Run the board in token mode and mint a token

```sh
# start the server in token mode (PORT and AGENTFACTORY_DB as usual)
AUTH_MODE=token npm run web          # or: AUTH_MODE=token npm run web:dev:server

# mint a personal token (raw value is shown once — copy it now)
npm run token -- --label "my phone" --email you@example.com --name "You"
```

`/api/*` and `/events` now require the token; the SPA shell and `/auth/whoami` stay public.
Service tokens for the ado-bridge loops: `npm run token -- --label ado-bridge --service`.

## 2. Put the phone and the workstation on the same Tailscale tailnet

Tailscale is the lowest-friction option: a private WireGuard network, no public exposure, no
DNS or TLS to manage.

1. Install Tailscale on the workstation and the phone; sign both into the same tailnet.
2. On the workstation: `tailscale status` — note its MagicDNS name (e.g. `devbox.tailnet-xxxx.ts.net`) or `100.x.y.z` IP.
3. On the phone, browse to `http://<devbox>:8787`.

## 3. Sign in on the phone, then install the PWA

- The board loads, the first data request 401s, and a **Sign in** gate appears. Paste the
  token from step 1. It is stored in the browser (localStorage) and sent on every request
  (and on the live `/events` stream via `?access_token=`), so you sign in once per device.
- Use the browser's **Add to Home Screen** to install the PWA — it launches standalone, with
  the board's icon, and keeps an offline shell (live data is always fetched fresh — the
  service worker is network-first).

## 4. (Later) Cloudflare Tunnel for a public HTTPS origin

When you want a real HTTPS hostname — for `Secure` cookies, broader device support, or sharing
with someone you won't enrol on the tailnet — front the local board with a Cloudflare Tunnel
(`cloudflared`). Token mode is still required. A public HTTPS origin is also the natural bridge
to the cloud/team phase of the roadmap.

## Notes

- **Reads/reviews/queueing work from the phone are safe** — they are ordinary HTTP calls; the
  dispatcher on the workstation picks up queued work as usual.
- Revoke a lost device by deleting its row from the `api_token` table (only the hash is stored).
- The token grants full board access; treat it like a password. Mint one per device so you can
  revoke individually.
