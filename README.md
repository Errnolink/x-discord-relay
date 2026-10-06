# X → Discord Relay (fixupx)

Relay any X/Twitter post to a Discord channel **as your own account, through the real Discord client** — no bot, no webhook, no user token, no Discord API calls. Post links are auto-converted to `fixupx.com` so videos and images embed properly.

An X-native send control appears when you hover a post on x.com (always visible on a post's own page): one click sends to your saved channel, `▾` opens options. Two transports:

- **Tab mode** *(default)* — a `discord.com` browser tab does the sending, driven like a human: navigate → paste → submit → back.
- **App mode** — the Discord **desktop app** does the sending via a tiny Vencord plugin, with no browser tab open at all.

---

## Contents
1. [Quickstart — Tab mode (2 minutes)](#quickstart--tab-mode-2-minutes)
2. [App mode — desktop app via Vencord](#app-mode--desktop-app-via-vencord)
3. [The send bar](#the-send-bar)
4. [How it works](#how-it-works)
5. [Troubleshooting](#troubleshooting)
6. [FAQ](#faq)
7. [Development](#development)
8. [Version history](#version-history)

---

## Quickstart — Tab mode (2 minutes)

**Requirements:** a Chromium browser, [Tampermonkey](https://www.tampermonkey.net/), a Discord account you're logged into.

1. Install Tampermonkey, then create a new userscript and paste in [`userscript/x-discord-relay.user.js`](userscript/x-discord-relay.user.js).
2. Open `discord.com` in a normal browser tab and click into any channel.
3. Open `x.com` — hovering any post now reveals a send bar under it (always visible on a post's own page).

Pick a server + channel on the bar (the list is built from channels you've recently visited in the Discord tab), press **Send**. The link lands in that channel as you, converted to `fixupx.com` for proper embeds. Done.

> The Discord tab must stay open — it's the thing doing the sending. That's what App mode (below) removes.

---

## App mode — desktop app via Vencord

App mode sends through the **Discord desktop app** instead of a browser tab, via a small Vencord plugin (`xdrRelay`). Tampermonkey storage can't cross the browser↔app boundary, so a tiny local broker bridges them:

```
x.com (userscript, App mode)              Discord desktop app
[mode chip]                               [xdrRelay Vencord plugin]
      │  GM_xmlhttpRequest                       │  fetch (CSP rule added by setup)
      ▼                                          ▼
http://127.0.0.1:8765   —   xdr-broker (local Node process)
```

**Requirements:** Discord desktop app, [Vencord](https://vencord.dev), Git, Node.js. Windows, macOS, and Linux are handled.

**Setup (one command):**

```
cd app-mode
node setup.mjs
```

It will: clone Vencord → copy the `xdrRelay` plugin into it (baking in a fresh broker token) → build → patch your Discord install → add the CSP rule that lets the plugin reach the broker → install the broker as an auto-starting background service → start it. Then:

1. Start Discord → **Settings → Vencord → Plugins → enable `xdrRelay`**.
2. Fully restart Discord once (tray icon → Quit → reopen) so the CSP rule applies.
3. On x.com, click any post's `▾` chevron, pick **App** in the composer options (it health-checks the broker), and send.

> `setup.mjs` / `rebuild.mjs` print a broker token on first run (also in `app-mode/broker/.token`, never committed). Paste it into the userscript once: set `BROKER_TOKEN` in `runXSide`. Without it the broker rejects App-mode requests once a token exists. The plugin gets it baked in automatically.

To undo everything: `node setup.mjs --uninstall` (removes the broker + autostart), and `pnpm uninject` inside `app-mode/vencord` restores stock Vencord.

**Maintenance model (read this):**
- Vencord plugins are **compiled into Vencord at build time** — there is no drop-in plugin folder. Your `setup.mjs` *is* the installer; it re-bakes the plugin on every run.
- If a Discord update breaks Vencord (blank/unmodded client), just run `node setup.mjs` again. ~5 minutes, no code changes.
- **Never update via the standalone Vencord installer** — it would overwrite this custom build and remove the plugin. `setup.mjs` is the only updater.

---

## The send bar

Hover a post on x.com to reveal a compact send control at the end of its action row (on a post's own page it stays visible). One click sends — the destination is on the button:

```
[➤ #channel @2 | ▾]
```

- **➤ #channel** — one-click send to your saved target (channel truncated to fit, `@N` badge when pings are on). Click → spinner → `✓ Sent` / `↻ Retry` right on the button; the toast carries the details. Your pick is remembered across posts; *"Open tab"* means "whatever channel is currently open on the sending side".
- **▾** — opens the composer sheet for everything else: post preview + fixupx link, `[Server ▾] [#channel ▾]`, `[Tab|App] [@ Preset ▾] [Ping on/off] [Edit]`, `[Cancel] [Send to #channel]`.
- **@ Preset / Edit** — click the preset name to switch; **Edit** opens the panel inline: click a chip to activate, double-click then click again to confirm delete, remove users via ✕, bulk-add by pasting IDs, create with `+ New preset`. No right-click gestures anywhere. When ping is ON, sends mention `<@id>` for every user in the active preset after the link. IDs are validated as 17–20 digit snowflakes.

**Quick-send:** a floating **Discord** pill (bottom-right on X, theme-aware) sends the last post you hovered instantly to the saved target. Dismiss it with its ✕ (persisted); right-click any post's send button to bring it back. Keyboard: **Alt+D** quick-sends the same way.

## How it works

**Tab mode** — both halves talk through Tampermonkey's cross-tab GM storage:

| Key | Writer | Purpose |
|---|---|---|
| `xdr.req` | X side | Single-slot request `{id, link, ts, ch, chG, chName, ping, pingUsers}` |
| `xdr.ack.<id>` | Discord side | Result ack, consumed on read |
| `xdr.lock.<id>` | Discord side | Claim guard against double-handling |
| `xdr.ping` | Discord side | Leader heartbeat (only one tab answers) |
| `xdr.history` | Discord side | Recent channels + server names/icons |
| `xdr.target` / `xdr.pingPreset` / `xdr.mode` / `xdr.pillHidden` | X side | Last selection / ping presets / transport mode / pill dismissed |

The Discord tab sends **DOM-primary**: it SPA-navigates to the target channel, *verifies the composer is really pointing at that channel* (aria-label check — the wrong-channel guard), pastes via a real `ClipboardEvent` (the only insert method that doesn't desync Discord's Slate editor), submits, navigates back. Internal `MessageActions.sendMessage` is fallback-only, because its promise resolves on *dispatch*, not delivery.

**App mode** — the broker (`app-mode/broker/xdr-broker.mjs`) mirrors the same protocol over HTTP: one-slot requests (15 s TTL), **claim-on-poll** delivery (a request is handed to the plugin exactly once — no redelivery, ever), acks delivered once (60 s TTL). The plugin sends through the client's own message actions and **verifies delivery by nonce** (waits up to 5 s for the message-create event carrying its nonce before acking `app-verified`; otherwise it acks honestly as `app-unverified`).

**Delivery honesty everywhere:** every path either proves the message landed or tells you exactly which step failed. Failed sends are never blindly retried — one send per request, ever.

## Troubleshooting

- **Nothing happens on Send (Tab mode):** is a discord.com tab open *with a channel clicked into it*? Tampermonkey enabled on both domains?
- **"no guild recorded for that channel":** open that channel once in the Discord tab; the entry self-heals.
- **"composer send failed":** the link may still be sitting in the composer — press Enter or clear it. Console-filter `xdr` in the Discord tab names the failing step.
- **App mode: "Broker unreachable":** the background broker isn't running — re-run `node app-mode/setup.mjs`.
- **App mode CSP error in Discord's console:** fully quit Discord (tray → Quit) and reopen; the CSP rule applies at boot.
- **Wrong server names/icons (Tab mode):** run `__xdrReport()` in the Discord tab's console — `mainRuntime: false` means the webpack capture latched onto the wrong runtime; it retries every 3 s.

## FAQ

**Is this against Discord's ToS?**
Discord prohibits *user-token automation* (self-bots). This project does none of that — there is no token handling and no Discord API calls anywhere. Sends go through the official client's own composer/IPC, at manual-click volume, one at a time. Client modification itself (Vencord-class) is a tolerated gray zone, same as themes and plugins. Use your judgment and your own account.

**Why does App mode need a whole Vencord build?**
Vencord has no runtime plugin loader — plugins are compiled in at build time by design. `setup.mjs` automates the entire process; you never touch the build manually.

**What happens when Discord or Vencord updates?**
Run `node app-mode/setup.mjs` again. That's the entire maintenance contract. (Tab mode is immune — it needs no client mod.)

**Does the X side upload anything?**
No. The userscript reads the page you're viewing, injects UI, and — for server icons only — fetches public Discord CDN images through Tampermonkey's CSP-exempt requester. The only other network traffic is loopback to the local broker in App mode.

## Development

```
userscript/x-discord-relay.user.js     the product — single IIFE, X side + Discord-tab side
app-mode/broker/xdr-broker.mjs         local HTTP bridge (no dependencies)
app-mode/vencord-plugin/xdrRelay/      the Vencord userplugin (TypeScript)
app-mode/setup.mjs                     cross-platform installer (also: --uninstall)
app-mode/rebuild.mjs                   redeploy plugin after any Vencord rebuild/Installer run
AGENTS.md                              working context, hard invariants, lessons ledger
issues.md                              external audit history
```

- Syntax gate after every userscript edit: `node --check userscript/x-discord-relay.user.js`.
- Userscript releases: bump `@version` **and both** `console.debug('[xdr] … active vX')` lines together (they have drifted before).
- Hard invariants (one-paste-per-request, nav-verify-before-paste, no `execCommand` insertText, no push-accessor hooks on Discord's webpack, live history reads) are listed in `AGENTS.md` — read it before touching the send path.

## Version history

| Version | Change |
|---|---|
| 1.0–1.1 | Hover menu, channel picker, leader election |
| 1.1.3 | Multi-probe webpack capture (Discord runs several runtimes) |
| 1.2 | Inline X-styled send bar; canvas-painted server icons (x.com CSP blocks `<img>`) |
| 1.3 | Bar below action row; GuildStore names; verified internals sends |
| 1.4 | **DOM-primary sends** with SPA navigation + channel-label verification |
| 1.4.1–1.4.3 | Single-paste `domSend` (poll-verified, `DOMFAIL` short-circuit), live history in bars, icon cache, audit fixes |
| 1.5–1.6.1 | **Ping presets**: popover manager, multi-preset tabs, bulk add, `<@id>` mentions; clean server names |
| 1.7.0 | **App mode**: mode chip, local broker, Vencord `xdrRelay` plugin with nonce-verified delivery acks |
| 1.8.0 | **UI pass**: hover-reveal bars, theme-aware dismissible quick-send pill, Alt+D quick-send, inline preset create/delete (no native dialogs), SVG mode chip, in-flight send guard, cross-tab ping-badge sync, `clientSend` payload parity fix (`invalidEmojis: []`, 4-arg `sendMessage`) |
| 1.9.0 | **Composer rebuild**: per-post button + single composer sheet replaces bar-per-post; singleton stylesheet + CSS-var theming, MutationObserver injection, keyboard-navigable menus, visible preset editing (no right-click gestures). **Split-button**: one-click `➤ #channel` send with inline spinner/sent/retry states, `▾` chevron for options |
| 1.9.1 | **Send-path latency**: nav sleeps (500+700ms) replaced with 50ms readiness polls (pathname → composer aria-label, nav-verify gate unchanged); Send-button click moved ahead of the dead synthetic Enter; all poll steps 50ms |
| 1.9.2 | **App-mode latency**: broker long-polling (`GET /poll?wait`, `GET /ack/:id?wait`, claim/consume still atomic); plugin subscribes `MESSAGE_CREATE` before sending (fixes 5s-timeout race), `waitForChannelReady=false`, cached module refs, chained re-poll loop, explicit failure acks |
| 1.10.0 | **Correctness + security audit fixes**: leader-side send queue (cap 3, `relay busy` drop), lock read-back, ack/lock keys deleted on consume (sweeper clears legacy blanks), composer-draft guard (`clear it first` error, single submit), cancellable history watcher, `__xdrXReport` diagnostics, hover-staleness guard. Broker: `X-XDR-1` client header + optional token (`XDR_BROKER_TOKEN`/`.token` file), Host/rebinding guard, Origin allowlist (no more CORS `*`), 409-busy fail-fast. Test suite: `node tests/run.mjs` (syntax + 26 invariant checks + 21 tests) |

## License

MIT for this repository's code. Vencord (cloned and built by `setup.mjs`) is GPL-3.0 and remains its own project — nothing of it is committed here.
