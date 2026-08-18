# X → Discord Relay — Issues & Fixes

> Audit of `x-discord-relay.user.js` — **v1.4.3 → v1.6.1**

---

## Changes in v1.6.1
- **Clean Server Names**: Stripped out Discord's unread message counts and mention notifications (e.g. "Server Name, 5 unread messages") that were being scraped from the DOM `aria-label`.

---

## Changes in v1.6.0 (Rewrite)

### ✅ Multi-Preset Ping System
- **Named Presets**: Create, manage, and switch between named preset groups instead of a single list.
- **Bulk Add**: Paste a list of user IDs separated by spaces or commas to add them all at once.
- **Improved UI**: Tabbed interface in the popover to switch active presets, with dedicated management tools.

### ✅ Bug Fixes
| Bug | Fix |
|---|---|
| Input field wouldn't accept text | Replaced bubble-phase `window` listener with a capture-phase `unsafeWindow` (`W`) listener. X's handlers are intercepted *before* they can consume keystrokes. |
| Server names not loading | The `guildMeta` fallback now combines DOM `aria-label`/`title`/`textContent` with the internal `GuildStore`. Also correctly unwraps Discord's webpack modules (`.default`, `.Z`, `.ZP`). |
| Version bumped to 1.6.0 | Header and logs updated to reflect the rewrite. |

---

## Changes in v1.5.0

### ✅ Ping Preset Feature (new)
The `@` button is no longer a placeholder. It now provides:
- **Preset management popover** — click `@` to open a popover listing saved Discord user IDs with labels
- **Add users** — enter a Discord user ID (17–20 digit snowflake) and an optional human-readable label
- **Remove users** — click ✕ next to any user to remove them from the preset
- **Toggle on/off** — right-click `@` to quickly toggle pings, or use the toggle row in the popover
- **Badge count** — the `@` button shows a count badge when users are in the preset
- **Persisted** — presets survive page reloads (stored in `xdr.pingPreset` via GM storage)
- **Wire-up** — when ping is ON, the relay request includes `pingUsers[]` array of IDs; the Discord side appends `<@userId>` mention strings after the fixupx link before sending

### ✅ Bug Fixes

| Bug | Fix |
|---|---|
| `guildIconFrom` only matched `cdn.discordapp.com` — Discord is migrating to `cdn.discord.com` | Regex now matches both via `cdn\.discord(app)?\.com` |
| `req.link` was sent directly — `pingUsers` in the payload were ignored by the Discord side | `handleRelay` now builds `content` by appending `<@id>` mentions when `pingUsers` is present |
| Version bumped from 1.4.3 → 1.5.0 | Header, X side log, Discord side log all consistent |

---

## Previously Fixed (v1.4.2 → v1.4.3)

These were identified in the first audit and already fixed by the user before this round:

| Issue | Status |
|---|---|
| PTB/Canary not in `@match` | ✅ Fixed |
| Election read-then-write race | ✅ Fixed (re-read after write) |
| `clientSend` missing nonce | ✅ Fixed |
| Retry loop doesn't re-check leadership | ✅ Fixed |
| Stale GM keys never purged | ✅ Fixed (`sweepStale`) |
| Icon cache not persisted | ✅ Fixed (data URL in GM storage, 24h TTL) |
| `history.pushState` shadowing | ✅ Fixed (`window.history.pushState`) |
| Animated icon URLs use `.png` | ✅ Fixed (`a_` prefix → `.gif`) |
| Version string mismatch | ✅ Fixed |
| No history change listener on X side | ✅ Fixed (`GM_addValueChangeListener`) |
| `sync()` reads stale snapshot | ✅ Fixed (live `history()` re-read in sync) |
| `channelsOf` reads stale hist | ✅ Fixed (calls `history()` live) |
| Missing `@connect cdn.discord.com` | ✅ Fixed |
| Overly broad article selector | ✅ Fixed (fallback only when no `data-testid=tweet`) |
