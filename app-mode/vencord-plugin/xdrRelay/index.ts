/*
 * xdrRelay — X → Discord relay, desktop-app side.
 *
 * Polls the local xdr-broker (127.0.0.1:8765) for relay requests written by
 * the X userscript's App mode, then sends them through the client's own
 * MessageActions — same payload shape the userscript's internals path uses.
 *
 * Delivery honesty: sendMessage resolves on DISPATCH, not delivery. When
 * verifyDelivery is on, we wait for MESSAGE_CREATE with our nonce before
 * acking 'app-verified'; on timeout we ack 'app-unverified'.
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

function waitForDelivery(channelId: string, nonce: string, timeoutMs: number): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const d = getDispatcher();
    if (!d) {
        resolve(false);
        return promise;
    }

    let settled = false;
    const onMsg = (ev: unknown) => {
        const info = deliveryInfo(ev);
        if (info.channelId === channelId && info.nonce === nonce) {
            if (!settled) {
                settled = true;
                d.unsubscribe("MESSAGE_CREATE", onMsg);
                resolve(true);
            }
        }
    };
    try {
        d.subscribe("MESSAGE_CREATE", onMsg);
    } catch {
        resolve(false);
        return promise;
    }
    setTimeout(() => {
        if (!settled) {
            settled = true;
            d.unsubscribe("MESSAGE_CREATE", onMsg);
            resolve(false);
        }
    }, timeoutMs);
    return promise;
}

async function handle(req: RelayRequest): Promise<void> {
    const pingIds = Array.isArray(req.pingUsers)
        ? req.pingUsers.filter(id => /^\d{17,20}$/.test(id))
        : [];
    let content = req.link;
    if (pingIds.length) content += " " + pingIds.map(id => `<@${id}>`).join(" ");

    const ack = (body: Record<string, unknown>) =>
        post(`/ack/${req.id}`, body).catch(e => log("ack failed", String(e)));

    // "Open tab" parity: a request without ch targets whatever channel the
    // app is currently viewing (same semantics as the browser-tab flow).
    let targetCh = req.ch;
    if (!targetCh) {
        const store: unknown = findByProps("getChannelId", "getVoiceChannelId");
        const getter = store && typeof store === "object" && "getChannelId" in store
            ? (store as Record<string, unknown>).getChannelId : undefined;
        if (typeof getter === "function") {
            try {
                const id = (getter as () => unknown).call(store);
                targetCh = typeof id === "string" && id.length > 0 ? id : null;
            } catch { /* keep null */ }
        }
        if (!targetCh) throw new Error("no channel picked and none open in the app — click into a channel, or pick a specific one on X");
        log("no ch in request — using app's current channel", targetCh);
    }

    try {
        // Vencord's findByProps is typed loosely; guard the one member we call.
        const found: unknown = findByProps("sendMessage", "editMessage");
        const sendMessage = found && typeof found === "object"
            && "sendMessage" in found && typeof found.sendMessage === "function"
            ? found.sendMessage as (ch: string, payload: Record<string, unknown>, waitForChannel: boolean, options: Record<string, unknown>) => unknown
            : undefined;
        if (!sendMessage) throw new Error("MessageActions not found");

        const nonce = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
        const payload = { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [], nonce };

        const sendPromise = Promise.resolve(sendMessage(targetCh, payload, true, {}));

        // MESSAGE_CREATE arrives via the dispatcher regardless of the send
        // promise's own resolution (which fires on dispatch, not delivery).
        const verified = settings.store.verifyDelivery
            ? await waitForDelivery(targetCh, nonce, 5000)
            : false;

        await sendPromise;

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

    start() {
        log("active — broker:", settings.store.brokerUrl);
        const tick = async () => {
            if (this.inFlight) return;
            this.inFlight = true;
            try {
                const res = await fetch(`${settings.store.brokerUrl}/poll`, { method: "GET" });
                const data = await res.json() as { req: RelayRequest | null };
                if (data?.req?.id && data.req.link) {
                    await handle(data.req);
                }
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
                this.inFlight = false;
            }
        };
        this.pollTimer = window.setInterval(tick, Math.max(250, settings.store.pollInterval ?? 1000));
    },

    stop() {
        if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
        this.pollTimer = undefined;
        log("stopped");
    }
});
