/*
 * xdrRelay — X → Discord relay, desktop-app side.
 *
 * Polls the local xdr-broker (127.0.0.1:8765) for relay requests written by
 * the X userscript's App mode, then sends them through the client's own
 * MessageActions — same payload shape the userscript's internals path uses.
 *
 * Delivery honesty: sendMessage resolves on DISPATCH, not delivery. When
 * verifyDelivery is on, we wait for the nonce-matched MESSAGE_CREATE echo
 * before acking 'app-verified' (first echo = dispatch + local echo, not a
 * server receipt); on timeout we ack 'app-unverified'.
 *
 * Latency design: one permanent MESSAGE_CREATE listener with a nonce map
 * (subscribed before sending — the echo can fire synchronously inside
 * sendMessage), cached module refs, waitForChannelReady=false, and broker
 * long-polling (GET /poll?wait=25000, chained re-poll) instead of 1 s polling.
 *
 * One-send invariant: a polled request is claimed exactly once by the broker
 * and is never redelivered; a failed send is ack'd as a failure — no retries.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findByProps } from "@webpack";
import { Flux } from "@webpack/common";

const settings = definePluginSettings({
    brokerUrl: {
        type: OptionType.STRING,
        description: "xdr-broker base URL",
        default: "http://127.0.0.1:8765",
    },
    pollInterval: {
        type: OptionType.NUMBER,
        description: "Poll interval in ms",
        default: 1000,
    },
    verifyDelivery: {
        type: OptionType.BOOLEAN,
        description: "Wait for MESSAGE_CREATE with our nonce before acking 'verified' (honest acks)",
        default: true,
    }
});

interface RelayRequest {
    id: string;
    link: string;
    ts: number;
    ch?: string | null;
    chG?: string | null;
    chName?: string | null;
    ping?: boolean;
    pingUsers?: string[];
}

interface DeliveryInfo {
    channelId?: string;
    nonce?: string;
}

interface Dispatcher {
    subscribe(event: string, cb: (e: unknown) => void): void;
    unsubscribe(event: string, cb: (e: unknown) => void): void;
}

function log(...args: unknown[]) {
    console.log("[xdrRelay]", ...args);
}

function hasFunction(value: unknown, key: string): boolean {
    return !!value && typeof value === "object" && key in value
        && typeof (value as Record<string, unknown>)[key] === "function";
}

function isDispatcher(value: unknown): value is Dispatcher {
    return hasFunction(value, "subscribe") && hasFunction(value, "unsubscribe");
}

// Discord passes MESSAGE_CREATE either as {type, message} or as the raw
// message object; tolerate both without casts.
function deliveryInfo(ev: unknown): DeliveryInfo {
    const source = ev && typeof ev === "object" && "message" in ev
        && ev.message && typeof ev.message === "object" ? ev.message : ev;
    const channelId = source && typeof source === "object" && "channel_id" in source
        && typeof source.channel_id === "string" ? source.channel_id : undefined;
    const nonce = source && typeof source === "object" && "nonce" in source
        && typeof source.nonce === "string" ? source.nonce : undefined;
    return { channelId, nonce };
}

// Flux carries the singleton dispatcher; fall back to a direct webpack lookup
// if Discord reshapes it.
function getDispatcher(): Dispatcher | null {
    let candidate: unknown;
    if (Flux && typeof Flux === "object" && "_dispatcher" in Flux) {
        candidate = Flux._dispatcher; // in-narrowed to unknown
    } else {
        candidate = findByProps("subscribe", "dispatch");
    }
    return isDispatcher(candidate) ? candidate : null;
}

async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(settings.store.brokerUrl + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {})
    });
}

function awaitDelivery(channelId: string, nonce: string, timeoutMs: number): { promise: Promise<boolean>; cancel: () => void } {
    ensureFluxListening();
    if (!fluxListening) return { promise: Promise.resolve(false), cancel: () => { } };
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<boolean>(resolve => {
        timer = setTimeout(() => {
            if (pendingDelivery.delete(nonce)) resolve(false);
        }, timeoutMs);
        pendingDelivery.set(nonce, { channelId, resolve, timer });
    });
    return {
        promise,
        cancel: () => {
            const w = pendingDelivery.get(nonce);
            if (w) {
                pendingDelivery.delete(nonce);
                clearTimeout(w.timer);
                w.resolve(false);
            }
        }
    };
}

const pendingDelivery = new Map<string, { channelId: string; resolve: (v: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
let fluxListening = false;

function onMessageCreate(ev: unknown) {
    const info = deliveryInfo(ev);
    if (!info.nonce) return;
    const w = pendingDelivery.get(info.nonce);
    if (w && w.channelId === info.channelId) {
        pendingDelivery.delete(info.nonce);
        clearTimeout(w.timer);
        w.resolve(true);
    }
}

function ensureFluxListening() {
    if (fluxListening) return;
    const d = getDispatcher();
    if (!d) return;
    try {
        d.subscribe("MESSAGE_CREATE", onMessageCreate);
        fluxListening = true;
    } catch { /* retry on next send */ }
}

function dropFluxListening() {
    if (!fluxListening) return;
    try {
        getDispatcher()?.unsubscribe("MESSAGE_CREATE", onMessageCreate);
    } catch { /* ignore */ }
    fluxListening = false;
}

type SendFn = (ch: string, payload: Record<string, unknown>, waitForChannel: boolean, options: Record<string, unknown>) => unknown;
let cachedSend: SendFn | undefined;
let cachedChannelId: (() => unknown) | undefined;

function getSendMessage(): SendFn | undefined {
    if (cachedSend) return cachedSend;
    const found: unknown = findByProps("sendMessage", "editMessage");
    const fn = found && typeof found === "object"
        && "sendMessage" in found && typeof found.sendMessage === "function"
        ? found.sendMessage as SendFn : undefined;
    if (fn) cachedSend = fn;
    return fn;
}

function getCurrentChannelId(): string | null {
    if (!cachedChannelId) {
        const store: unknown = findByProps("getChannelId", "getVoiceChannelId");
        const getter = store && typeof store === "object" && "getChannelId" in store
            ? (store as Record<string, unknown>).getChannelId : undefined;
        if (typeof getter !== "function") return null;
        cachedChannelId = () => (getter as () => unknown).call(store);
    }
    try {
        const id = cachedChannelId();
        return typeof id === "string" && id.length > 0 ? id : null;
    } catch {
        cachedChannelId = undefined;
        return null;
    }
}

function dropModuleCache() {
    cachedSend = undefined;
    cachedChannelId = undefined;
}

async function handle(req: RelayRequest): Promise<void> {
    const ack = (body: Record<string, unknown>) =>
        post(`/ack/${req.id}`, body).catch(e => log("ack failed", String(e)));

    try {
        const pingIds = Array.isArray(req.pingUsers)
            ? req.pingUsers.filter(id => /^\d{17,20}$/.test(id))
            : [];
        let content = req.link;
        if (pingIds.length) content += " " + pingIds.map(id => `<@${id}>`).join(" ");

        // "Open tab" parity: a request without ch targets whatever channel the
        // app is currently viewing (same semantics as the browser-tab flow).
        let targetCh = req.ch;
        if (!targetCh) {
            targetCh = getCurrentChannelId();
            if (!targetCh) throw new Error("no channel picked and none open in the app — click into a channel, or pick a specific one on X");
            log("no ch in request — using app's current channel", targetCh);
        }

        const sendMessage = getSendMessage();
        if (!sendMessage) throw new Error("MessageActions not found");

        const nonce = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
        const payload = { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [], nonce };

        // Subscribe BEFORE sending: the optimistic MESSAGE_CREATE echo can
        // fire synchronously inside sendMessage, and a post-send subscribe
        // misses it (then every send burns the full 5 s timeout).
        const waiter = settings.store.verifyDelivery ? awaitDelivery(targetCh, nonce, 5000) : null;
        let sendErr: unknown = null;
        try {
            await Promise.resolve(sendMessage(targetCh, payload, false, {}));
        } catch (e) {
            sendErr = e;
        }
        if (sendErr) {
            waiter?.cancel();
            dropModuleCache();
            throw sendErr;
        }

        const verified = waiter ? await waiter.promise : false;

        log("sent", targetCh, verified ? "(verified)" : "(unverified)", content);
        await ack({
            ok: true,
            ch: targetCh,
            chName: req.chName,
            via: verified ? "app-verified" : "app-unverified"
        });
    } catch (e) {
        log("send failed", String(e));
        const message = e instanceof Error ? e.message : String(e);
        await ack({ ok: false, ch: req.ch ?? null, chName: req.chName, err: message });
    }
}

export default definePlugin({
    name: "xdrRelay",
    description: "Relay X posts from the X userscript's App mode via the local xdr-broker (127.0.0.1:8765). Requires the broker running.",
    authors: [{ name: "xdr-relay contributors", id: 0n }],
    settings,

    pollTimer: undefined as number | undefined,
    inFlight: false,
    cspWarned: false,
    _stopLoop: undefined as (() => void) | undefined,
    _pendingAbort: undefined as (() => void) | undefined,

    start() {
        log("active — broker:", settings.store.brokerUrl);
        ensureFluxListening();
        let stopped = false;
        this._stopLoop = () => {
            stopped = true;
            try { this._pendingAbort?.(); } catch { /* ignore */ }
        };
        const backoffMs = () => Math.max(250, settings.store.pollInterval ?? 1000);
        const sleep = (ms: number) => new Promise<void>(r => { this.pollTimer = window.setTimeout(r, ms); });
        const loop = async () => {
            while (!stopped) {
                const t0 = Date.now();
                try {
                    const ctrl = new AbortController();
                    this._pendingAbort = () => { try { ctrl.abort(); } catch { /* ignore */ } };
                    const killer = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, 30000);
                    let data: { req: RelayRequest | null } | null = null;
                    try {
                        const res = await fetch(`${settings.store.brokerUrl}/poll?wait=25000`, { method: "GET", signal: ctrl.signal });
                        data = (await res.json()) as { req: RelayRequest | null };
                    } catch (e) {
                        // TypeError from fetch = CSP still blocking localhost
                        if (e instanceof TypeError && !this.cspWarned) {
                            this.cspWarned = true;
                            console.error(
                                "[xdrRelay] Cannot reach the broker (CSP?). Open Vencord Settings → Vencord →",
                                "Custom CSP Rules and add:  connect-src = http://127.0.0.1 ws://127.0.0.1",
                                "then fully restart Discord. Broker URL:", settings.store.brokerUrl
                            );
                        }
                    } finally {
                        clearTimeout(killer);
                        this._pendingAbort = undefined;
                    }
                    if (!stopped && data?.req?.id && data.req.link) {
                        this.inFlight = true;
                        try {
                            await handle(data.req);
                        } finally {
                            this.inFlight = false;
                        }
                    } else if (!stopped && Date.now() - t0 < 1000) {
                        await sleep(backoffMs());
                    }
                } catch {
                    if (!stopped) await sleep(backoffMs());
                }
            }
        };
        loop();
    },

    stop() {
        try { this._stopLoop?.(); } catch { /* ignore */ }
        this._stopLoop = undefined;
        if (this.pollTimer !== undefined) window.clearTimeout(this.pollTimer);
        this.pollTimer = undefined;
        dropFluxListening();
        log("stopped");
    }
});
