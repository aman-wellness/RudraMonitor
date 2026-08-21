# Making Live View & Remote work from anywhere (WFH, other countries, any network)

Goal: an admin anywhere on earth can view and control any employee's machine,
whatever network either side is on — home wifi, hotel, cellular, or a
locked-down corporate/foreign ISP — **and** the connection stays low-latency
when the network allows a direct path.

Reality after this work (read §3.5 for the why): the **admin** side reaches from
any network. The **employee/agent** side reaches from any network that passes
**outbound UDP** — which is all normal home and mobile networks, but not a
network that blocks UDP outright. Closing that last gap is an agent-code change
that is scoped but not yet done (§3.5). So this gets you "works for WFH from
anywhere with normal internet," and stops short of "literally any network on the
employee side" until that change lands.

This document is the deployment runbook. The **code** changes that go with it
are already in the repo (see "Code changes" at the end). The **infrastructure**
here — a public host, DNS, and a TLS certificate — is yours to stand up; it
cannot be done from a dev machine.

---

## 1. Why it fails today, in one paragraph

WebRTC has two phases: *signaling* (the "let's connect" handshake, over your
HTTPS domain — works everywhere already) and *media* (the actual video and
control packets, peer-to-peer over UDP). Media only flows directly when the two
machines can reach each other. On the same LAN they can, so it's fast. Across
two home routers they can't, and the only fix is a **TURN relay**: a public
server both sides can always reach, which forwards the packets. You have no
working public relay in production, so cross-network media has nowhere to go —
Remote never connects, and Live "loads forever" once the employee is off-site.

## 2. The design: fast when possible, reachable always

The relay is a *fallback*, not the default. ICE (WebRTC's path selector)
gathers every candidate and uses the best it can connect, in this order:

1. **Direct / STUN** — a true peer-to-peer path. Latency = raw network RTT.
   This is the common case on home and mobile networks, and it's the fast one.
2. **TURN/UDP** — relay with the least overhead, when direct fails.
3. **TURN/TCP** — for networks that pass TCP but block UDP.
4. **TURN/TLS on 443** — the universal last resort. To every firewall it looks
   like an ordinary HTTPS connection, so it gets through almost everything,
   including hotel wifi and strict corporate/foreign ISPs. Costs one extra hop.

Because relay is last, a well-connected session pays **zero** relay latency;
only a badly-firewalled one takes the slower path — and even then it connects.
That satisfies both "low latency" and "works anywhere" without compromise.

> **Latency across countries:** a single relay adds a hop through wherever the
> relay lives. If the admin is in the US and the employee in India and the relay
> is in India, US→relay→India is fine. If most of your relaying will be
> cross-continent, put the relay near the employees (see §6, geo-distribution).
> Direct paths (the common case) are unaffected either way.

---

## 3. Remote Desktop — the coturn relay (do this first; it's the whole fix)

Remote is direct peer-to-peer, so it depends entirely on the relay.

### 3.1 Host + DNS + cert (yours to provision)
- A small VM with a **public, static IP** (1 vCPU / 1 GB is plenty for control
  + a few screen streams; size up for many concurrent sessions).
- A DNS **A record**, e.g. `turn.wellnessextract.com` → that IP.
- A **TLS certificate** for that name (Let's Encrypt is free):
  ```
  certbot certonly --standalone -d turn.wellnessextract.com
  ```

### 3.2 coturn config
`/etc/turnserver.conf` (or the flags below via Docker). The TLS listener on
443 is the part that was missing and is what makes it work everywhere:

```
listening-port=3478            # STUN + TURN over UDP and TCP
tls-listening-port=443         # TURN over TLS — the universal path
fingerprint
use-auth-secret
static-auth-secret=<TURN_SHARED_SECRET>   # must match the edge secret
realm=turn.wellnessextract.com
cert=/etc/letsencrypt/live/turn.wellnessextract.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.wellnessextract.com/privkey.pem
# Advertise the address OTHER machines reach — the public IP, not a private one.
external-ip=<PUBLIC_IP>
# Relay port range. Open ALL of these to the internet or media fails after ICE
# appears to succeed. Keep it modest to start.
min-port=49160
max-port=49200
no-cli
no-multicast-peers
# Uncomment in production to stop the relay being used to reach internal hosts:
# denied-peer-ip=10.0.0.0-10.255.255.255
# denied-peer-ip=192.168.0.0-192.168.255.255
```

Docker equivalent:
```
docker run -d --name coturn --network host \
  -v /etc/letsencrypt:/etc/letsencrypt:ro \
  coturn/coturn -n \
  --listening-port=3478 --tls-listening-port=443 \
  --fingerprint --use-auth-secret \
  --static-auth-secret=$TURN_SHARED_SECRET \
  --realm=turn.wellnessextract.com \
  --cert=/etc/letsencrypt/live/turn.wellnessextract.com/fullchain.pem \
  --pkey=/etc/letsencrypt/live/turn.wellnessextract.com/privkey.pem \
  --external-ip=$PUBLIC_IP --min-port=49160 --max-port=49200 \
  --no-cli --no-multicast-peers
```
`--network host` matters: Docker's NAT bridge breaks the relay's own ICE
checks. Run coturn on the host network, not a bridge.

### 3.3 Firewall (open to the whole internet, not just your office)
- `443/tcp` (TURN-TLS) and `3478/tcp`+`3478/udp` (STUN/TURN)
- `49160-49200/udp` (the relay range above)

### 3.4 Edge secrets (Supabase → Project Settings → Edge Functions → Secrets)
```
TURN_SHARED_SECRET = <the same secret as coturn>
TURN_HOST          = turn.wellnessextract.com
# Only if the TLS cert is on a different name than TURN_HOST:
# TURN_TLS_HOST    = turn.wellnessextract.com
# TURN_TLS_PORT    = 443    (default; override only if 443 is taken)
```
Then redeploy `webrtc-turn-credentials`. It now hands out STUN + TURN/UDP +
TURN/TCP + TURN/TLS-443 (previously UDP only — that alone left every
UDP-blocked network dead).

### 3.5 KNOWN LIMIT — the agent relays over UDP only (verified in the crate)
This is confirmed, not a maybe. The agent uses `webrtc-ice` 0.13, whose
`gather_candidates_relay` implements **only `Udp + Turn`**; the TURN/TCP and
TURN/TLS branches are unimplemented `TODO`s
(`webrtc-ice-0.13.0/src/agent/agent_gather.rs:796-799`, everything else falls to
"Unable to handle URL"). So:

- The **admin/browser** side uses any transport, TURN/TLS-443 included — it can
  connect from any network.
- The **employee/agent** side can only get a relay candidate over **UDP**. The
  TCP and TLS entries the credentials function now returns are simply ignored by
  the agent.

Practical outcome:

| Employee's network | Remote works? |
| --- | --- |
| Home wifi, cellular/hotspot (pass outbound UDP) | ✅ yes, via UDP relay |
| Strict corporate / hotel / some foreign ISPs that **block UDP** | ❌ not with today's agent |

Outbound UDP is open on essentially all home and mobile networks, so **normal
WFH is covered**. The only gap is an employee sitting on a fully UDP-hostile
network.

**Verified:** `webrtc-ice` 0.13 also leaves **ICE-TCP unimplemented** — local
candidate gathering is hard-coded to UDP (`agent_gather.rs:271-287`, a
commented-out TODO). So the agent cannot use TCP for media by any route,
including *to LiveKit*. Routing the agent through LiveKit does NOT escape this;
the agent→SFU media hop is the same webrtc-rs UDP-only stack. Closing the gap
therefore needs one of:

1. **Upgrade or fork `webrtc-rs`** to a version that implements ICE-TCP and/or
   TURN over TCP/TLS. This is the "stay on WebRTC" fix, but 0.13→newer is a
   breaking dependency change that touches all of the streaming/remote code, and
   a fork means maintaining the transport ourselves. High effort, real risk.
2. **A non-WebRTC TLS-443 fallback transport** for the agent: when ICE fails,
   tunnel H.264 frames + control over the outbound WSS/TLS-443 connection the
   agent already holds open (a relay endpoint, or the existing realtime socket).
   Outbound 443 works on every network, so this is the definitive fix, and it is
   self-contained (no third-party transport internals). It is a sizeable build:
   a server relay endpoint + an agent sender + a dashboard receiver, used only
   when WebRTC can't connect.

Until one lands, set expectations at "any home or mobile network," not
"literally any network," for the **employee** side.

---

## 4. Live View — the LiveKit SFU

Live goes through LiveKit (the agent publishes; the browser subscribes). Which
fix applies depends on where LiveKit runs. Note the **same agent-side UDP
limit** from §3.5 applies here: the agent publishes to the SFU with webrtc-rs,
so it reaches the SFU over outbound UDP (fine on home/mobile; not on a
UDP-blocked employee network). The browser subscriber can use TLS-443 and is
unrestricted.

### Case A — LiveKit Cloud (recommended for "just works globally")
LiveKit Cloud has geo-distributed TURN/TLS-443 built in. If you point at Cloud,
Live View works from anywhere with no relay work on your side.
- Set the edge secrets the token function reads to your Cloud project:
  `LIVEKIT_URL` (wss://<your>.livekit.cloud), `LIVEKIT_API_KEY`,
  `LIVEKIT_API_SECRET`, and the ingress/WHIP base Cloud gives you.
- Nothing else to host. This is the lowest-effort way to hit the "any country,
  any network" bar for Live.

### Case B — self-hosted LiveKit
Your SFU must be publicly reachable AND offer a TLS-443 fallback for
UDP-blocked clients. In `livekit.yaml`:
```yaml
rtc:
  use_external_ip: true        # advertise the PUBLIC ip, not a private one
  # (do NOT set node_ip to a private/loopback address in prod — that is the
  #  local-dev setting and is exactly what makes off-site clients hang)
  port_range_start: 50000
  port_range_end: 50200        # open this udp range to the internet
turn:
  enabled: true
  domain: livekit.wellnessextract.com
  tls_port: 443                # LiveKit's own TURN-over-TLS — the universal path
  # cert/key for livekit.wellnessextract.com (its own name + cert)
```
- DNS `livekit.wellnessextract.com` → the SFU's public IP; cert for that name.
- Open `443/tcp` and the RTC UDP range to the internet.
- Because LiveKit's TURN wants 443, it needs its **own** host/IP separate from
  coturn (both can't bind 443 on the same IP). Two names, two certs, two IPs —
  or use LiveKit Cloud (Case A) and skip this entirely.

---

## 5. How to verify it actually works from anywhere

Do these from a device **outside your office** (phone on cellular is the
easiest real-world test):

1. **Relay reachable:** open `https://icetest.info` or the Trickle-ICE tool
   (`https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/`),
   enter `turns:turn.wellnessextract.com:443?transport=tcp` with a username/
   credential from the `webrtc-turn-credentials` endpoint, and confirm a
   candidate of type **relay** appears. No relay candidate = relay/cert/port
   problem, fix that before anything else.
2. **Remote across networks:** employee PC on home wifi, admin on cellular →
   Remote connects within the 8s watchdog.
3. **UDP-blocked path:** put one side on a network that blocks UDP → it should
   still connect via TURN/TLS-443 (this is the case that was impossible before).
4. **Latency sanity:** on a normal home network, the control-channel RTT shown
   in the Remote UI should stay low (direct path); it only rises when the
   session is forced onto the relay.

---

## 6. Optional: lower relay latency for a global team (do later)

A single relay is enough for "works anywhere." If cross-continent relaying
becomes common and feels slow, run **one coturn per region** (e.g. one in
India, one in the US/EU) behind the same `static-auth-secret`, and have
`webrtc-turn-credentials` return the relay nearest the caller (by request geo,
or a per-org setting). The credentials function is already the single place
that builds the ICE list, so this is a localized change when you want it — say
the word and I'll add region selection.

---

## 7. The "any network" fallback pipeline (TLS-443 relay)

This is the path that makes the employee reachable even on a UDP-blocked
network — the case raw WebRTC cannot handle (§3.5). Clients try WebRTC first
and only use this when ICE fails, so a normal session never touches it and pays
no extra latency.

```
  agent  ──(outbound wss:443)──►  RELAY  ◄──(outbound wss:443)──  dashboard
         H.264 frames  ─────────────────────────────────►  (decode → canvas)
         (inject input) ◄─────────────  control JSON  ─────
```

### Wire protocol (relay is a dumb pass-through; these two define it)
WebSocket messages between agent and viewer, forwarded verbatim by the relay:

- **Binary, agent → viewer (video).** Byte 0 is a tag:
  - `0x02` config: the rest is the H.264 decoder config (SPS+PPS, Annex-B). Sent
    first and whenever it changes. Never dropped.
  - `0x01` media: byte 1 = `1` for a keyframe (IDR) / `0` for a delta; bytes 2–9
    = presentation timestamp (µs, big-endian u64); the rest is one Annex-B
    access unit. The relay may drop *delta* frames under backpressure; keyframes
    and config are never dropped.
- **Text, viewer → agent (control).** The **exact same** JSON the Remote
  DataChannel already uses (`{t:"mouse_move",...}`, `key`, `clip_set`, etc.), so
  the agent reuses its existing control handler unchanged.
- **Text, relay → each side (status).** `relay_hello{peer_present}`,
  `peer_joined`, `peer_left`.

### Stage 2 — agent sender (Rust, `agent/src-tauri/src/`)
- New module `relay_fallback.rs`: opens `wss` to `url` from
  `webrtc-relay-token`, presenting `?token=`.
- Reuse the **existing encoder**: `webrtc_stream.rs` / `whip_publisher.rs`
  already spawn ffmpeg (or the native encoder) producing an H.264 Annex-B
  stream. Split SPS/PPS into a `0x02` config message; frame each access unit as
  `0x01` with the keyframe flag (detect IDR by NAL type 5 / SPS/PPS presence).
- Reuse the **existing input injection** (`enigo`) for control JSON coming back.
- Trigger: the streaming loop starts WebRTC as today; if ICE doesn't reach
  `connected` within the watchdog, it opens the relay socket instead and pushes
  the same encoder output there. Request a keyframe on viewer `peer_joined`.

### Stage 3 — dashboard receiver (TS, `src/lib/` + `RemoteStage`/Live views)
- New `relayClient.ts`: opens the relay `wss`, feeds incoming video into a
  **WebCodecs `VideoDecoder`** (`codec: "avc1.*"`, configured from the `0x02`
  message), and draws decoded `VideoFrame`s to a `<canvas>`. WebCodecs is in
  Chrome/Edge, which is what the dashboard targets.
- Send input as the same control JSON the DataChannel path sends.
- Trigger: `remoteControl.ts` / the Live view try WebRTC first; on failure they
  fall back to `relayClient` against the same session id. The UI switches the
  `<video>` element for the decoder `<canvas>` transparently.

### Testing gates (each stage verifiable on its own)
1. Relay: `deno run infra/relay/relay.ts`, connect two `wscat` clients with
   valid tokens to the same session, confirm bytes forwarded and backpressure
   drop works. **(Stage 1 — runnable now.)**
2. Agent sender: point it at a local relay, confirm a browser test page decodes
   the H.264 to canvas. Requires a compile + on-machine run.
3. End to end: employee PC on a **UDP-blocked** network, admin remote → Live and
   Remote both work through the relay. This is the acceptance test and needs
   real infrastructure + a real UDP-blocked network.

### Server config for the fallback
Edge secrets: `RELAY_SECRET` (shared with the relay) and `RELAY_WSS_URL`
(e.g. `wss://relay.wellnessextract.com/ws`). Deploy `webrtc-relay-token`. Put
the relay behind TLS/443 (own host, or the same box as coturn on a different
port fronted by a proxy). DNS + cert for its name, same as §3.1.

## Code changes already made (in this repo)

- `supabase/functions/webrtc-turn-credentials/index.ts` — now returns STUN +
  TURN/UDP + TURN/TCP + **TURN/TLS-443**, ordered so ICE prefers the fast direct
  path and only falls back to relay when needed. New optional env:
  `TURN_TLS_HOST`, `TURN_PORT`, `TURN_TLS_PORT`. Safe to deploy immediately:
  ICE ignores any relay endpoint that isn't up yet, so this strictly improves
  reachability and changes nothing until coturn's TLS listener exists.
- `infra/relay/relay.ts` — the TLS-443 media relay (§7). Self-contained Deno
  service.
- `supabase/functions/webrtc-relay-token/index.ts` — authenticates
  agent/dashboard and mints the relay's per-session HMAC token.
- `agent/src-tauri/src/relay_fallback.rs` — **agent sender**: on `relay_start`,
  opens the relay socket, streams the H.264 the encoder already produces, and
  applies control back through the existing input pipeline. Wired into the
  signaling loop in `webrtc_stream.rs` (`relay_start` / `relay_stop`).
- `src/lib/relayClient.ts` — **dashboard receiver**: decodes H.264 via WebCodecs
  to a canvas, exposes it as a MediaStream so the existing `<video>` path is
  unchanged, sends control over the relay.
- `src/lib/remoteControl.ts` — `startRemoteSessionWithFallback`: WebRTC first,
  relay on failure, same handle either way.
- `src/pages/monitoring/components/RemoteStage.tsx` and `LiveTab.tsx` — both now
  fall back to the relay when their WebRTC/LiveKit path can't connect.

**Build status:** the agent compiles (`cargo check` clean) and the dashboard
builds (`vite build` clean). That is a compile, NOT a working-system test — see
below.

## What is NOT done (and why)

- No infrastructure was provisioned or tested — a public host, DNS, and TLS cert
  are required and are yours to create. None of the above has been verified
  against a live relay from this machine.
- LiveKit prod config (§4) is a template; the exact values depend on whether you
  run Cloud or self-host, which only you know.
- The any-network fallback (§7) is now **fully built** (relay + token + agent
  sender + dashboard receiver, Remote and Live), and it compiles — but it has
  NOT been run end to end. It needs: the relay deployed behind TLS/443, the two
  edge secrets (`RELAY_SECRET`, `RELAY_WSS_URL`) set, and the agent rebuilt +
  shipped. The specific things most likely to need a real-run pass:
  - **H.264 framing / WebCodecs decode** — the Annex-B split (agent) and the
    codec-string + Annex-B decode (browser) are written to spec but unverified
    against a real stream; the first live test may need a tweak here.
  - **The fallback trigger timing** — Remote falls back after its 8s watchdog;
    Live falls back only after its 90s no-video timeout, which is slow. Once
    proven, shorten the Live trigger.
- Nothing here is tested against real infrastructure or a real UDP-blocked
  network. Treat every config, both new services, and the media pipeline as
  unverified until you run them on your own host with a cert, then test from a
  phone on cellular and from a UDP-blocked network.
