# AGENTS.md — X → Discord Relay: Working Context

> Read this before touching anything in this folder. Written 2026-08-18 after v1.6.x; updated same day (README refreshed to 1.6.1, preset E2E landed).
> Feature-level docs live in `README.md` (current through v1.6.1).

## 1. What this is

A Tampermonkey userscript (`x-discord-relay.user.js`, single file, ~1270 lines) that relays X/Twitter posts to Discord channels **as the user's own account through the official web client** — no tokens, no Discord REST API, no webhooks. Links are rewritten to `fixupx.com` for proper embeds.

**User profile (matters for every decision):**
- Discord in a **browser tab only** (never the Windows app — the whole design depends on a browser tab). Uses split view: X on one side, Discord on the other.
- Tampermonkey in a Chromium browser on this Windows box.
- Cares about: speed of the send flow, UI blended into X's look, and **no account risk**. Has been burned by half-tested updates — verify properly before handing anything over (see §7).
- Historically offered a Discord test account for live verification; that account got banned (Discord's signup-abuse filter — do NOT automate rapid UI actions on fresh accounts; it looks botty and gets banned within minutes).

## 2. Files

| Path | Role |
|---|---|
| `userscript/x-discord-relay.user.js` | The product. Single IIFE, two halves dispatched by hostname. |
| `README.md` | User/feature documentation + protocol + FAQ (public-facing, current through v1.7.0). |
| `issues.md` | External audit (15 issues) with a v1.4.3 resolution banner at top. |
| *(dev box)* `…/kanso/scripts/xdr-e2e.mjs` | **Regression harness** (kept outside this repo): two live pages (x.com + discord.com login) with Node-bridged GM-storage stubs, running the real script end-to-end. Keep runnable.

| `app-mode/broker/xdr-broker.mjs` | Local HTTP bridge (127.0.0.1:8765) for App mode: one-slot requests, claim-on-poll, single-delivery acks. |
| `app-mode/vencord-plugin/xdrRelay/index.ts` | Desktop-app side of App mode; Vencord userplugin (requires self-built Vencord). |
| `app-mode/setup.mjs` | Cross-platform one-time setup: clone+build+inject Vencord with the plugin, CSP rule, broker auto-start. |

## 3. Current state (v1.7.0)

- Version state as of 2026-08-18 (v1.7.0): header `@version 1.7.0`, both console log lines `v1.7.0` — consistent. The drift bug is recurring (audit issue #5): on every release, bump `@version` AND both `console.debug('[xdr] … active vX')` lines together.
- v1.7.0 added **App mode**: 💬/🖥 chip on bars (persisted `xdr.mode`, default `tab` = untouched GM-storage flow), local broker (`broker/xdr-broker.mjs`, verified by live round-trip), Vencord plugin `xdrRelay` (nonce-verified delivery via MESSAGE_CREATE). Broker round-trip + full e2e green; the plugin itself compiles in the user's self-built Vencord (one-time `setup.mjs`) — logged-in app send is user-verified.
- v1.5/1.6 added the **ping preset system** — **E2E-verified 2026-08-18** (full coverage in `xdr-e2e.mjs`: popover CRUD on the real x.com page, `pingUsers` payload wiring on/off, mention-append asserted by executing the shipped transform bytes against the captured payloads):
  - `xdr.pingPreset` storage: `{presets: {Name: [{id, label}]}, active, on}`.
  - X side: `@` button = toggle + count; opens a preset manager popover (tabs per preset, add/delete presets via `W.prompt`/`W.confirm`, user list, add/remove users; IDs validated `/^\d{17,20}$/`).
  - Request payload carries `pingUsers: [ids]`; Discord side appends `<@id> …` mentions to the content before sending (`handleRelay`, ~line 1232).
- User-reported status after v1.4.2: sends were landing via the DOM-nav path (this was the phantom-send fix working); no unresolved complaint on record since.

## 4. Architecture in one screen

```
x.com/twitter.com                          discord.com (+ptb/canary)
┌ runXSide() ─────────────────┐            ┌ runDiscordSide() ───────────────┐
│ send-bar under each post:   │            │ leader election (2s ticks,      │
│  [icon] Server▾ #channel▾   │  GM store  │  write-confirmed, qualified =  │
│  [@ presets] [Send]         │◄──────────►│  channel-open tab outranks)     │
│ floating ➤ pill             │ xdr.req /  │ history: route watcher (1s) +   │
│ link → fixupx.com           │  xdr.ack.* │  guild rail + GuildStore names  │
│ toast + 12s ack polling     │  xdr.lock.*│  + icons; 4s backfill loop      │
│ icons: canvas via GM xhr    │  xdr.ping  │ send: DOM-primary (navigate →   │
│  (x.com CSP blocks <img>)   │  xdr.history│  paste → submit → back),       │
│                             │  xdr.target│  internals only as fallback     │
└─────────────────────────────┘  xdr.icons └─────────────────────────────────┘
                                 xdr.pingPreset
```

Key payload shapes:
- `xdr.req`: `{id, link, ts, ch, chG, chName, ping, pingUsers}` — `chG` (guild id) is what makes DOM navigation possible; entries without it can only use internals.
- `xdr.history`: `[{id, guild, name, gname, gicon, ts}]` cap 6 — **must be read live, never snapshotted** (audit issues 1–2: a frozen snapshot was why names/icons "never showed").
- `xdr.icons`: `{url: {d: dataURL, ts}}`, 24h TTL.
- Timing invariants: X timeout 12s > Discord attempt window 10s; request expiry 15s; ping freshness 5s; sweep 60s.

## 5. Hard invariants — do not break these

1. **One paste per request, ever.** `domSend` pastes exactly once and every step is poll-verified (`pollUntil`); `DOMFAIL` short-circuits all retries with an explicit ack. Reintroducing retry-paste = duplicate/concatenated messages in Discord (happened twice: v1.4.0 stacking, v1.4.1 async race).
2. **Never trust `MessageActions.sendMessage` for delivery.** Its promise resolves on *dispatch* — it "succeeds" even logged out. DOM-nav is the only verified path; internals is fallback-only. (App mode honors this with nonce verification: acks distinguish `app-verified` from `app-unverified`.)
3. **Nav-verify before pasting**: after `spaNavigate('/channels/{g}/{c}')`, the composer's aria-label must contain the target channel name, else refuse to paste and navigate back. This is the wrong-channel guard.
4. **No `execCommand('insertText')`** into Discord's Slate composer (desyncs the model → undeletable text). Only `ClipboardEvent('paste')` inserts; `execCommand` allowed solely for `selectAll`+`delete` clearing.
5. **No push-accessor/document-start hooks on `webpackChunkdiscord_app`** — corrupted Discord boot once (v1.3.0, "Discord not loading"). Capture = plain fake-chunk probes + `"b" in r` main-runtime validation + factory-source scan (`r.m`) as rescue.
6. **Bars read history live** (`channelsOf` calls `history()`; `bar.sync()` rebuilds server list) and a single module-level `GM_addValueChangeListener(HIST_KEY)` refreshes all bars on remote writes.
7. **Leadership**: qualified tabs (channel open) outrank others; write-confirmed (`isLeader` from read-back); re-checked before every retry and at request handling.
8. **No account-risk surfaces**: no tokens, no API calls, human-click volume only. This is the user's explicit requirement.
9. **App mode one-send across the broker**: requests are claim-on-poll (delivered to the plugin exactly once, never redelivered); a failed send acks failure explicitly. The broker is the enforcement point — do not add redelivery/retry there.

## 6. Lessons ledger (symptom → root cause → fix)

| Symptom | Root cause | Fix (version) |
|---|---|---|
| Pasted text can't be deleted/sent | `execCommand('insertText')` desyncs Slate | `ClipboardEvent` paste (1.1.0) |
| "No client internals" forever | single webpack probe latched a 102-module non-app runtime | multi-probe + `"b" in r` validation (1.1.3/1.3.x) |
| Discord wouldn't load at all | document-start push-accessor hook broke boot | plain probes only (1.3.1) |
| Toast says Sent, nothing arrives | `sendMessage` resolves on dispatch, not delivery | DOM-primary navigate-paste-send (1.4.0) |
| Doubled/concatenated links | retry loop re-pasted over leftover drafts | single-paste + poll-verify + `DOMFAIL` no-retry (1.4.2) |
| Menu stuck open / then closing instantly | X re-renders kill node-identity hover logic; mousedown-close vs click-reopen race | geometry-free singleton popover + reopen suppression (1.2.x/1.4.1) |
| Server names/icons never show | frozen history snapshot + no update trigger + rail selector stale + icons are CSS backgrounds + CSP blocks CDN `<img>` | live reads + HIST listener + GuildStore (incl. factory scan) + computed-style icon URLs + canvas painting (1.2/1.3.2/1.4.3) |
| Bar overlapped X's action icons | `[data-testid=reply]`'s parent is just its group | climb to first ancestor with ≥3 children, insert after it (1.3.1) |
| Channel dropdown "not syncing" | per-bar selection state | shared module-level `runXSide.sel` + bar registry (1.3.2) |
| App-mode send: "Cannot read properties of undefined (reading 'nonce')" | desktop `MessageActions.sendMessage` takes **4 args** `(channelId, message, waitForChannelReady, options)` — missing 4th → internals read `.nonce` of undefined; also `invalidEmojis` must be `[]`, not `false` | 4-arg call `(ch, payload, true, {})` + `invalidEmojis: [], validNonShortcutEmojis: []` (1.7.0, diagnosed by external review of the compiled renderer) |
| Wrong tab answered relays | unqualified tabs could lead | qualified election (1.1.1) |


**Rebuilding after a plugin change (App mode):** `cd vencord && pnpm build && pnpm inject` is NOT enough — a re-patch does not refresh the payload files. After every build, copy `vencord\dist\*` over `%APPDATA%\Vencord\dist\`, then fully restart Discord (tray → Quit). `node setup.mjs` does this automatically on re-runs. PowerShell note: use `pnpm.cmd` (the `pnpm.ps1` shim is blocked without `-ExecutionPolicy Bypass`).

## 7. Dev workflow on this box

- **Syntax gate:** `node --check userscript\x-discord-relay.user.js` after every edit. Non-negotiable — the edit tool has auto-repaired/mangled ranges several times; **re-read any region you edit** and never trust an unverified multi-hunk batch.
- **Regression gate:** run the Playwright e2e harness (dev box, outside this repo): `node scripts/xdr-e2e.mjs` from its own repo; it reads the userscript by absolute path (line 4 — keep pointing at `userscript/x-discord-relay.user.js` after moves). Expected: all PASS except the known artifact `ack received by X tab → consumed (toast shown instead)` — the toast line proving the round-trip is the real assertion. The harness STUB must provide `GM_listValues`/`GM_deleteValue` or startup throws.
- **Extract-and-eval for content transforms** (learned 2026-08-18): intercepting `ma.sendMessage` in-page under Playwright is UNRELIABLE — the webpack runtime identity you wrap churns between `evaluate` calls (plain objects on `window` survive, Set references don't; scans that read 54 matches inside a tick read 0 from the next evaluate). To assert what the Discord side SENDS, regex-extract the shipped transform (e.g. the ping-append lines of `handleRelay`) and `eval` it in Node against captured payloads. Used by the preset tests; prefer it over in-page interception.
- **Browser:** playwright-core with a local Chromium `executablePath` (dev box path in the harness). x.com articles render logged-out only after ~9s; Discord's login page is a valid lab for webpack capture (it has both runtimes).
- **Tooling traps:** shell `grep` with parentheses in patterns misreports through bash here — use the Grep tool. PowerShell `$vars` get eaten unless the command is single-quoted.
- **Cannot be tested here:** a logged-in send. The user is the final verifier; ship with the diagnostic story intact (next section).
- **Releasing:** bump `@version` **and both** `console.debug('[xdr] … active vX')` lines; user re-pastes into Tampermonkey and reloads both tabs (browser restart never required — tabs reload is enough; icons re-cache from GM storage within 24h TTL).

## 8. Diagnostics to give the user (or run via attached CDP)

- `__xdrReport()` in the Discord tab console → `{leader, internals, matcher, mainRuntime, runtimes:[{c, m, main}]}`. `internals:false` + `mainRuntime:false` = capture problem; `runtimes` with one small `c` = probes landing wrong.
- Console filter `xdr` in either tab — every state transition logs (`nav-verify failed`, `paste did not land`, `flushed=false`, `sent via dom-nav|dom|client(...)`).
- Toast text carries the failure reason and `at:` path of the answering tab.

## 9. Open items

1. ~~Ping presets E2E~~ done 2026-08-18 (see §3).
2. ~~README refresh~~ done 2026-08-18 (current through v1.7.0, incl. protocol table + history rows + App mode §7).
3. Known cosmetic debt: per-bar `syncAllBars` copies inside `buildBar` (harmless duplicates of the module-level one).
4. If icons ever fail again with `mainRuntime:true`, check `gicon` extraction first (computed-style URL) before suspecting capture.
5. ~~Discord desktop app support~~ BUILT 2026-08-18 (v1.7.0 App mode). Remaining: user runs `node setup.mjs` (one-time; self-built Vencord) and verifies a logged-in app send. After Discord updates that break the patch: `git pull && pnpm build && pnpm inject` in `vencord\`.
