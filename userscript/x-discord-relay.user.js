// ==UserScript==
// @name         X → Discord Relay (fixupx)
// @namespace    xdr.local
// @version      1.10.0
// @description  Send any X post to Discord as YOUR account through the official client — no token, no API. An X-styled bar under every post: pick server + channel, @ ping presets, one-click Send. Links auto-convert to fixupx.com.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://discord.com/*
// @match        https://ptb.discord.com/*
// @match        https://canary.discord.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_listValues
// @grant        GM_deleteValue
// @connect      cdn.discordapp.com
// @connect      cdn.discord.com
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(() => {
  'use strict';

  // ---------------- shared ----------------
  const REQ_KEY = 'xdr.req';
  const PING_KEY = 'xdr.ping';
  const HIST_KEY = 'xdr.history';
  const ackKey = id => 'xdr.ack.' + id;
  const lockKey = id => 'xdr.lock.' + id;
  const PING_PRESET_KEY = 'xdr.pingPreset';
  // Tampermonkey sandbox: page globals (like Discord's webpack) live on the real window
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  const gget = (k, d = '') => { try { return GM_getValue(k, d); } catch (e) { return d; } };
  const gset = (k, v) => { try { GM_setValue(k, v); } catch (e) {} };

  let toastCount = 0; // simple stacking so rapid sends don't overlap
  function toast(msg, kind) {
    kind = kind || 'info';
    const t = document.createElement('div');
    t.textContent = msg;
    const css = {
      position: 'fixed', left: '50%', bottom: (52 + toastCount * 48) + 'px', transform: 'translateX(-50%)',
      'z-index': '2147483647', 'max-width': '82vw',
      padding: '10px 16px', 'border-radius': '10px',
      font: '600 14px/1.35 system-ui, -apple-system, sans-serif', color: '#fff',
      background: kind === 'ok' ? '#153e26' : kind === 'err' ? '#41121d' : '#1c1f2e',
      border: '1px solid ' + (kind === 'ok' ? '#2ecc71' : kind === 'err' ? '#ff5c7a' : '#667bff'),
      'box-shadow': '0 8px 28px rgba(0,0,0,.5)', 'pointer-events': 'none',
      opacity: '0', transition: 'opacity .15s ease'
    };
    Object.keys(css).forEach(p => t.style.setProperty(p, css[p]));
    toastCount++;
    document.documentElement.appendChild(t);
    requestAnimationFrame(() => t.style.setProperty('opacity', '1'));
    setTimeout(() => {
      t.style.setProperty('opacity', '0');
      setTimeout(() => { t.remove(); toastCount--; }, 250);
    }, kind === 'err' ? 4500 : 2800);
  }

  // purge ack/lock keys abandoned by a crashed or closed tab (values carry ts)
  function delKey(k) {
    try {
      if (typeof GM_deleteValue === 'function') GM_deleteValue(k);
      else gset(k, '');
    } catch (e) {}
  }
  function sweepStale() {
    try {
      if (typeof GM_listValues !== 'function' || typeof GM_deleteValue !== 'function') return;
      const now = Date.now();
      for (const k of GM_listValues()) {
        if (!k.startsWith('xdr.ack.') && !k.startsWith('xdr.lock.')) continue;
        const v = gget(k, '');
        if (!v) { GM_deleteValue(k); continue; }
        let ts = 0;
        try { ts = JSON.parse(v).ts || 0; } catch (e) { const m = String(v).match(/:(\d{12,})/); if (m) ts = +m[1]; }
        if (!ts || now - ts > 60000) GM_deleteValue(k);
      }
    } catch (e) {}
  }

  // x.com/user/status/123(+anything) → https://fixupx.com/user/status/123
  function fixupLink(url) {
    try {
      const u = new URL(url, location.origin);
      if (!/(^|\.)x\.com$/.test(u.hostname) && !/(^|\.)twitter\.com$/.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/|$)/);
      if (!m) return null;
      if (/^(i|home|settings|search|explore|notifications|messages|compose|intent|share)$/.test(m[1])) return null;
      return 'https://fixupx.com/' + m[1] + '/status/' + m[2];
    } catch (e) { return null; }
  }

  // ---------------- X side ----------------
  function runXSide() {
    const SEND_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';
    const TARGET_KEY = 'xdr.target';
    const MODE_KEY = 'xdr.mode';
    const BROKER = 'http://127.0.0.1:8765';
    const BROKER_TOKEN = '';
    function brokerHeaders(extra) {
      const h = Object.assign({ 'X-XDR-1': '1' }, extra || {});
      if (BROKER_TOKEN) h['X-XDR-Token'] = BROKER_TOKEN;
      return h;
    }

    const CSS_TEXT = [
      '.xdr-split{display:inline-flex;align-items:center;flex:0 0 auto;max-width:210px;background:transparent;border:none;opacity:.6;transition:opacity .12s ease}',
      'article:hover .xdr-split,article:focus-within .xdr-split{opacity:1}',
      'article[data-xdr-main] .xdr-split{opacity:1}',
      '.xdr-go{display:flex;align-items:center;gap:4px;padding:4px 2px;cursor:pointer;background:transparent;border:none;font:400 13px system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--xdr-sub,#536471);white-space:nowrap;overflow:hidden}',
      '.xdr-go:hover{color:#1d9bf0}',
      '.xdr-go svg{flex:0 0 auto;color:inherit}',
      '.xdr-go span.t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.xdr-go span.b{color:inherit;font-size:11px;font-weight:700}',
      '.xdr-chev{display:flex;align-items:center;padding:4px 6px;cursor:pointer;background:transparent;border:none;color:var(--xdr-sub,#536471);font-size:9px;opacity:.45}',
      'article:hover .xdr-chev,.xdr-split:hover .xdr-chev{opacity:.9}',
      '.xdr-chev:hover{color:#1d9bf0;opacity:1}',
      '.xdr-spin{width:12px;height:12px;flex:0 0 auto;border-radius:50%;border:2px solid rgba(29,155,240,.3);border-top-color:#1d9bf0;animation:xdrrot .7s linear infinite}',
      '@keyframes xdrrot{to{transform:rotate(360deg)}}',
      '.xdr-go.ok{color:#2ecc71}',
      '.xdr-go.fail{color:#ff5c7a}',
      '#xdrOverlay{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 16px}',
      '#xdrOverlay[hidden]{display:none}',
      '#xdrSheet{width:min(440px,94vw);max-height:82vh;overflow:auto;border-radius:16px;padding:6px;font:14px system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--xdr-bg,#fff);color:var(--xdr-fg,#0f1419);border:1px solid var(--xdr-line,#eff3f4);box-shadow:0 16px 48px rgba(0,0,0,.35);opacity:0;transform:translateY(-4px);transition:opacity .12s ease,transform .12s ease}',
      '#xdrOverlay.open #xdrSheet{opacity:1;transform:none}',
      '.xdr-head{display:flex;align-items:center;gap:8px;padding:10px 12px 6px;font-weight:800;font-size:15px}',
      '.xdr-x{margin-left:auto;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;cursor:pointer;color:var(--xdr-sub,#536471);font-weight:800}',
      '.xdr-x:hover{background:rgba(29,155,240,.1)}',
      '.xdr-post{margin:2px 12px 8px;padding:8px 10px;border-radius:10px;font-size:12.5px;line-height:1.4;color:var(--xdr-sub,#536471);background:rgba(29,155,240,.07);overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow-wrap:anywhere}',
      '.xdr-post a{color:#1d9bf0;text-decoration:none}',
      '.xdr-sec{padding:2px 12px 8px}',
      '.xdr-lbl{font-size:11.5px;font-weight:700;color:var(--xdr-sub,#536471);margin:6px 0 6px;text-transform:uppercase;letter-spacing:.04em}',
      '.xdr-row{display:flex;gap:8px;flex-wrap:wrap}',
      '.xdr-pick{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:6px;padding:8px 12px;border-radius:9999px;cursor:pointer;border:1px solid var(--xdr-line,#eff3f4);font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden}',
      '.xdr-pick:hover{background:rgba(29,155,240,.1)}',
      '.xdr-pick span.t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.xdr-pick span.c{color:var(--xdr-sub,#536471);font-size:10px;margin-left:auto}',
      '.xdr-seg{display:flex;border:1px solid var(--xdr-line,#eff3f4);border-radius:9999px;overflow:hidden}',
      '.xdr-seg div{padding:8px 14px;cursor:pointer;font-weight:700;font-size:13px;color:var(--xdr-sub,#536471)}',
      '.xdr-seg div.on{background:#1d9bf0;color:#fff}',
      '.xdr-toggle{padding:8px 12px;border-radius:9999px;cursor:pointer;border:1px solid var(--xdr-line,#eff3f4);font-weight:700;font-size:13px}',
      '.xdr-panel{margin:8px 0 0;border:1px solid var(--xdr-line,#eff3f4);border-radius:12px;padding:8px 10px}',
      '.xdr-panel[hidden]{display:none}',
      '.xdr-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}',
      '.xdr-chip{padding:4px 12px;border-radius:9999px;cursor:pointer;font-weight:700;font-size:12px;border:1px solid var(--xdr-line,#eff3f4);color:var(--xdr-sub,#536471)}',
      '.xdr-chip.on{background:#1d9bf0;border-color:#1d9bf0;color:#fff}',
      '.xdr-urow{display:flex;align-items:center;gap:8px;padding:5px 2px;font-size:13px}',
      '.xdr-urow .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}',
      '.xdr-urow .i{color:var(--xdr-sub,#536471);font-size:11px;white-space:nowrap}',
      '.xdr-urow .rm{cursor:pointer;font-weight:800;font-size:12px;padding:2px 6px;border-radius:6px;color:var(--xdr-sub,#536471)}',
      '.xdr-urow .rm:hover{color:#ff5c7a;background:rgba(255,92,122,.1)}',
      '.xdr-add{display:flex;gap:6px;margin-top:8px}',
      '.xdr-add input{flex:1;min-width:0;padding:7px 10px;border-radius:8px;border:1px solid var(--xdr-line,#eff3f4);background:transparent;color:var(--xdr-fg,#0f1419);font-size:13px;outline:none}',
      '.xdr-add input:focus{border-color:#1d9bf0}',
      '.xdr-btn2{padding:7px 12px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;color:#1d9bf0;white-space:nowrap}',
      '.xdr-btn2:hover{background:rgba(29,155,240,.1)}',
      '.xdr-btn2.danger{color:#ff5c7a}',
      '.xdr-foot{display:flex;gap:8px;justify-content:flex-end;padding:8px 12px 12px}',
      '.xdr-cancel{padding:9px 18px;border-radius:9999px;cursor:pointer;font-weight:700;font-size:14px;color:var(--xdr-fg,#0f1419)}',
      '.xdr-cancel:hover{background:rgba(29,155,240,.1)}',
      '.xdr-send{padding:9px 22px;border-radius:9999px;cursor:pointer;font-weight:800;font-size:14px;background:#1d9bf0;color:#fff;border:none}',
      '.xdr-send:hover{background:#1a8cd8}',
      '.xdr-send.off{opacity:.45;pointer-events:none}',
      '#xdrMenu{position:fixed;z-index:2147483647;min-width:200px;max-width:280px;max-height:320px;overflow:auto;padding:4px;border-radius:14px;font:13px system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--xdr-bg,#fff);color:var(--xdr-fg,#0f1419);border:1px solid var(--xdr-line,#eff3f4);box-shadow:0 8px 28px rgba(0,0,0,.3);opacity:0;transform:translateY(-2px);transition:opacity .12s ease,transform .12s ease}',
      '#xdrMenu[hidden]{display:none}',
      '#xdrMenu.open{opacity:1;transform:none}',
      '.xdr-mi{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer;font-weight:600}',
      '.xdr-mi:hover,.xdr-mi.hot{background:rgba(29,155,240,.12)}',
      '.xdr-mi .s{color:var(--xdr-sub,#536471);font-size:11px;margin-left:auto;padding-left:8px;white-space:nowrap}',
      '.xdr-mi .k{color:#1d9bf0;font-weight:800}',
      'html[data-xdr-theme="dark"]{--xdr-bg:#1e2126;--xdr-fg:#e7e9ea;--xdr-sub:#71767b;--xdr-line:#2f3336}',
      'html[data-xdr-theme="light"]{--xdr-bg:#ffffff;--xdr-fg:#0f1419;--xdr-sub:#536471;--xdr-line:#eff3f4}'
    ].join('\n');

    function ensureCss() {
      if (document.getElementById('xdrCss')) return;
      const st = document.createElement('style');
      st.id = 'xdrCss';
      st.textContent = CSS_TEXT;
      (document.head || document.documentElement).appendChild(st);
    }

    function applyTheme() {
      let dark = false;
      try {
        const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
        if (m && m.length >= 3) dark = (+m[0] * .299 + +m[1] * .587 + +m[2] * .114) < 128;
        else dark = matchMedia('(prefers-color-scheme: dark)').matches;
      } catch (e) { dark = matchMedia('(prefers-color-scheme: dark)').matches; }
      document.documentElement.setAttribute('data-xdr-theme', dark ? 'dark' : 'light');
    }

    let lastTweetUrl = null;
    let lastTweetText = '';
    let lastHoverTs = 0;
    let healCount = 0;

    function getPingData() {
      try {
        const d = JSON.parse(gget(PING_PRESET_KEY, '{}'));
        if (d && d.presets) return d;
      } catch (e) {}
      return { presets: { Default: [] }, active: 'Default', on: true };
    }
    function setPingData(d) { gset(PING_PRESET_KEY, JSON.stringify(d)); }
    function isPingOn() { return getPingData().on !== false; }

    function articleUrl(article) {
      if (!article) return null;
      const time = article.querySelector('a[href*="/status/"] time');
      let a = time ? time.closest('a') : null;
      if (!a) {
        for (const el of article.querySelectorAll('a[href*="/status/"]')) {
          try {
            if (/^\/[^/]+\/status\/\d+$/.test(new URL(el.getAttribute('href'), location.origin).pathname)) { a = el; break; }
          } catch (e) {}
        }
      }
      if (!a) return null;
      try { return new URL(a.getAttribute('href'), location.origin).href; } catch (e) { return null; }
    }
    function articleSnippet(article) {
      try {
        const t = (article.querySelector('[data-testid="tweetText"]') || article).innerText || '';
        const s = t.replace(/\s+/g, ' ').trim();
        return s.length > 140 ? s.slice(0, 140) + '…' : s;
      } catch (e) { return ''; }
    }

    const store = {
      sel: null,
      histV: 0,
      hist: [],
      readHist() {
        try { const h = JSON.parse(gget(HIST_KEY, '[]')); this.hist = Array.isArray(h) ? h : []; }
        catch (e) { this.hist = []; }
        return this.hist;
      },
      servers() {
        const out = [];
        const seen = new Set();
        for (const hh of this.hist) {
          const g = hh.guild || 'other';
          if (seen.has(g)) continue;
          seen.add(g);
          out.push({ g, label: hh.gname || (g === '@me' ? 'Direct Messages' : g === 'other' ? 'Other' : 'Server …' + String(g).slice(-4)) });
        }
        return out;
      },
      channelsOf(g) { return this.hist.filter(hh => (hh.guild || 'other') === g); }
    };
    store.readHist();
    if (!store.sel) {
      let t0 = null;
      try { const t = JSON.parse(gget(TARGET_KEY, 'null')); if (t && t.id) t0 = t; } catch (e) {}
      if (!t0) t0 = store.hist[0] || null;
      const s0 = (t0 && t0.guild && store.hist.some(hh => (hh.guild || 'other') === t0.guild)) ? t0.guild : '__current';
      store.sel = {
        server: s0,
        channel: s0 === '__current' ? null
          : (store.hist.find(hh => t0 && hh.id === t0.id && (hh.guild || 'other') === s0) || store.hist.find(hh => (hh.guild || 'other') === s0) || null)
      };
    }

    function chanLabel(hh) {
      if (!hh) return 'open channel';
      return (hh.name && hh.name[0] === '#') ? hh.name
        : ((hh.guild === '@me') ? (hh.name || hh.id) : '#' + (hh.name || hh.id));
    }
    function srvLabel(g) {
      if (g === '__current') return 'Open tab';
      const s = store.servers().find(x => x.g === g);
      return s ? s.label : 'Server';
    }
    function currentEntry() {
      return store.sel.server === '__current' ? null : store.sel.channel;
    }
    function persistTarget() {
      const t = currentEntry();
      if (t) gset(TARGET_KEY, JSON.stringify(t)); else gset(TARGET_KEY, 'null');
    }
    function reselect() {
      if (store.sel.server !== '__current' && store.sel.channel) {
        const fresh = store.hist.find(hh => hh.id === store.sel.channel.id);
        if (fresh) store.sel.channel = fresh;
      }
    }

    function setSending(v) {
      runXSide.sending = v;
      const s = document.getElementById('xdrSend');
      if (s) {
        s.classList.toggle('off', !!v);
        s.textContent = v ? 'Sending…' : ('Send to ' + (currentEntry() ? chanLabel(currentEntry()) : 'open channel'));
      }
    }

    let appAlive = null;
    function getMode() { return gget(MODE_KEY, 'tab') === 'app' ? 'app' : 'tab'; }
    function gmXhr() { return (typeof GM_xmlhttpRequest === 'function') ? GM_xmlhttpRequest : null; }
    function brokerHealth(cb) {
      const x = gmXhr();
      if (!x) { appAlive = false; cb(false); return; }
      let done = false;
      const fin = ok => { if (!done) { done = true; appAlive = ok; cb(ok); } };
      try {
        x({ method: 'GET', url: BROKER + '/health', timeout: 2500, onload: r => fin(r.status === 200), onerror: () => fin(false), ontimeout: () => fin(false) });
      } catch (e) { fin(false); }
    }
    function appRelay(payload, cb) {
      const x = gmXhr();
      if (!x) { toast('App mode needs Tampermonkey GM_xmlhttpRequest', 'err'); return; }
      const ackUrl = BROKER + '/ack/' + payload.id;
      const finish = ok => { setSending(false); try { if (cb) cb(ok); } catch (e) {} };
      x({
        method: 'POST', url: BROKER + '/req', timeout: 4000,
        headers: brokerHeaders({ 'Content-Type': 'application/json' }),
        data: JSON.stringify(payload),
        onload: r => {
          if (r.status === 409) { toast('Relay busy — a send is already in flight, retry', 'err'); finish(false); return; }
          if (r.status !== 200) { toast('Broker rejected request: ' + r.responseText, 'err'); finish(false); return; }
          const t0 = Date.now();
          let lastStart = 0;
          const reAttempt = () => {
            if (Date.now() - lastStart < 400) setTimeout(attempt, 250);
            else attempt();
          };
          const attempt = () => {
            lastStart = Date.now();
            const remain = 12000 - (Date.now() - t0);
            if (remain < 1000) {
              toast('Discord app did not answer. Is the xdrRelay plugin enabled in Vencord?', 'err');
              finish(false);
              return;
            }
            x({
              method: 'GET', url: ackUrl + '?wait=' + Math.min(10000, remain - 500), timeout: 15000,
              headers: brokerHeaders(),
              onload: rr => {
                if (rr.status === 200 && rr.responseText) {
                  let ack = {}; try { ack = JSON.parse(rr.responseText); } catch (e) {}
                  if (ack.pending) { reAttempt(); return; }
                  if (ack.ok) toast('Sent to ' + (ack.chName || ('channel ' + ack.ch)) + ' ✓ via app' + (ack.via === 'app-verified' ? '' : ' (unverified)'), 'ok');
                  else toast('Discord app: ' + (ack.err || 'unknown error'), 'err');
                  finish(!!ack.ok);
                } else if (Date.now() - t0 > 12000) {
                  toast('Discord app did not answer. Is the xdrRelay plugin enabled in Vencord?', 'err');
                  finish(false);
                } else reAttempt();
              },
              onerror: () => { if (Date.now() - t0 > 12000) { toast('Broker unreachable mid-poll', 'err'); finish(false); } else reAttempt(); },
              ontimeout: () => { if (Date.now() - t0 > 12000) { toast('Broker timeout mid-poll', 'err'); finish(false); } else reAttempt(); }
            });
          };
          attempt();
        },
        onerror: () => { toast('Broker unreachable — is xdr-broker running?', 'err'); finish(false); },
        ontimeout: () => { toast('Broker timeout — is xdr-broker running?', 'err'); finish(false); }
      });
    }

    function relay(rawUrl, target, ping, cb) {
      setSending(true);
      const doneCb = ok => { setSending(false); try { if (cb) cb(ok); } catch (e) {} };
      const url = rawUrl || lastTweetUrl || location.href;
      const link = fixupLink(url);
      if (!link) { toast('No post permalink found (hover a post first, or use its timestamp link)', 'err'); doneCb(false); return; }
      const id = (crypto.randomUUID ? crypto.randomUUID() : 'r' + Date.now() + Math.random()).replace(/[^a-z0-9]/gi, '');
      let pingUsers = [];
      try {
        const d = getPingData();
        if (ping) pingUsers = (d.presets[d.active] || []).map(u => u.id);
      } catch (e) {}
      const payload = {
        id, link, ts: Date.now(),
        ch: target ? target.id : null,
        chG: target ? (target.guild || null) : null,
        chName: target ? target.name : null,
        ping: !!ping,
        pingUsers
      };
      toast('Relaying to ' + (target ? chanLabel(target) : 'open channel') + (pingUsers.length ? ' +' + pingUsers.length + ' pings' : '') + ' …');
      if (getMode() === 'app') {
        if (appAlive === false) {
          toast('App mode: broker not reachable. Start xdr-broker, or switch back to Tab mode.', 'err');
          doneCb(false);
          return;
        }
        appRelay(payload, cb);
        return;
      }
      delKey(ackKey(id));
      delKey(lockKey(id));
      gset(REQ_KEY, JSON.stringify(payload));
      const key = ackKey(id);
      const t0 = Date.now();
      const iv = setInterval(() => {
        const raw = gget(key, '');
        if (raw) {
          clearInterval(iv);
          let ack = {}; try { ack = JSON.parse(raw); } catch (e) {}
          if (ack.ok) toast('Sent to ' + (ack.chName || ('channel ' + ack.ch)) + ' ✓', 'ok');
          else toast('Discord tab' + (ack.at ? ' (' + ack.at + ')' : '') + ': ' + (ack.err || 'unknown error'), 'err');
          delKey(key); delKey(lockKey(id)); doneCb(!!ack.ok);
        } else if (Date.now() - t0 > 12000) {
          clearInterval(iv);
          toast('No Discord tab answered. Open discord.com in a browser tab and click into a channel first.', 'err');
          delKey(key); delKey(lockKey(id)); doneCb(false);
        }
      }, 120);
    }

    document.addEventListener('mouseover', e => {
      const el = e.target;
      if (!el || !el.closest) return;
      const art = el.closest('article[data-testid="tweet"]') || el.closest('article');
      if (art) {
        const u = articleUrl(art);
        if (u) { lastTweetUrl = u; lastTweetText = articleSnippet(art); lastHoverTs = Date.now(); }
      }
    }, true);
    document.addEventListener('focusin', e => {
      const el = e.target;
      if (!el || !el.closest) return;
      const art = el.closest('article[data-testid="tweet"]') || el.closest('article');
      if (art) {
        const u = articleUrl(art);
        if (u) { lastTweetUrl = u; lastTweetText = articleSnippet(art); lastHoverTs = Date.now(); }
      }
    }, true);
    function quickFresh() {
      if (/^\/[^/]+\/status\/\d+/.test(location.pathname)) return true;
      if (!lastTweetUrl || Date.now() - lastHoverTs > 30000) {
        toast('Hover a post first — quick-send needs a recent hover', 'err');
        return false;
      }
      return true;
    }

    let menu = null;
    let menuSuppress = 0;
    function closeMenu() { if (menu) { menu.remove(); menu = null; } }
    function openMenu(anchor, items, onPick) {
      if (Date.now() < menuSuppress) return;
      closeMenu();
      const m = document.createElement('div');
      m.id = 'xdrMenu';
      m.setAttribute('role', 'listbox');
      m.hidden = true;
      let hot = Math.max(0, items.findIndex(it => it.selected));
      items.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'xdr-mi' + (i === hot ? ' hot' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', it.selected ? 'true' : 'false');
        row.tabIndex = -1;
        const lbl = document.createElement('span');
        lbl.textContent = it.label;
        row.appendChild(lbl);
        if (it.sub) {
          const sub = document.createElement('span');
          sub.className = 's';
          sub.textContent = it.sub;
          row.appendChild(sub);
        }
        if (it.selected) {
          const k = document.createElement('span');
          k.className = 'k';
          k.textContent = ' ✓';
          row.appendChild(k);
        }
        row.addEventListener('click', ev => { ev.stopPropagation(); closeMenu(); onPick(it); });
        row.addEventListener('mousemove', () => {
          m.querySelectorAll('.xdr-mi').forEach(r => r.classList.remove('hot'));
          row.classList.add('hot');
          hot = i;
        });
        m.appendChild(row);
      });
      document.documentElement.appendChild(m);
      const r = anchor.getBoundingClientRect();
      m.hidden = false;
      requestAnimationFrame(() => m.classList.add('open'));
      const mw = m.offsetWidth;
      const mh = m.offsetHeight;
      let x = Math.min(Math.max(8, r.left), innerWidth - mw - 8);
      let y = r.bottom + 6;
      if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
      m.style.left = x + 'px';
      m.style.top = y + 'px';
      menu = m;
      menu.__xdrAnchor = anchor;
      let query = '';
      let qTimer = 0;
      menu.__xdrKey = e => {
        const rows = Array.from(m.querySelectorAll('.xdr-mi'));
        if (e.key === 'Escape') { e.preventDefault(); closeMenu(); anchor.focus(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          hot = (hot + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
          rows.forEach(rr => rr.classList.remove('hot'));
          if (rows[hot]) { rows[hot].classList.add('hot'); rows[hot].scrollIntoView({ block: 'nearest' }); }
        }
        else if (e.key === 'Enter') { e.preventDefault(); closeMenu(); onPick(items[hot]); }
        else if (e.key.length === 1) {
          query += e.key.toLowerCase();
          clearTimeout(qTimer);
          qTimer = setTimeout(() => { query = ''; }, 600);
          const j = items.findIndex(it => (it.label || '').toLowerCase().startsWith(query));
          if (j >= 0) {
            hot = j;
            rows.forEach(rr => rr.classList.remove('hot'));
            if (rows[j]) { rows[j].classList.add('hot'); rows[j].scrollIntoView({ block: 'nearest' }); }
          }
        }
      };
    }
    document.addEventListener('mousedown', e => {
      if (menu && !(e.target && menu.contains(e.target))) {
        const wasAnchor = !!(menu.__xdrAnchor && menu.__xdrAnchor.contains(e.target));
        closeMenu();
        if (wasAnchor) menuSuppress = Date.now() + 250;
      }
      const ov = document.getElementById('xdrOverlay');
      if (ov && !ov.hidden && e.target === ov) closeComposer();
    }, true);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (menu && menu.__xdrKey) menu.__xdrKey(e);
        else closeComposer();
      } else if (menu && menu.__xdrKey && ['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) {
        menu.__xdrKey(e);
      } else if (menu && menu.__xdrKey && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.target && e.target.getAttribute && e.target.getAttribute('data-xdr-input')) return;
        menu.__xdrKey(e);
      }
    }, true);
    ['keydown', 'keyup', 'keypress'].forEach(evt =>
      W.addEventListener(evt, e => {
        if (!e.target || !e.target.getAttribute || !e.target.getAttribute('data-xdr-input')) return;
        if (e.key === 'Escape') return;
        if (e.type === 'keydown' && e.key === 'Enter' && e.target.__xdrEnter) {
          e.preventDefault();
          e.target.__xdrEnter();
        }
        e.stopPropagation();
      }, true));
    window.addEventListener('scroll', closeMenu, true);

    const composer = { link: null, editOpen: false, delArm: null };

    function el(tag, cls, text) {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    }

    function buildComposer() {
      if (document.getElementById('xdrOverlay')) return;
      const ov = el('div');
      ov.id = 'xdrOverlay';
      ov.hidden = true;
      const sheet = el('div');
      sheet.id = 'xdrSheet';
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-label', 'Send to Discord');
      const head = el('div', 'xdr-head', 'Send to Discord');
      const x = el('div', 'xdr-x', '✕');
      x.setAttribute('role', 'button');
      x.setAttribute('aria-label', 'Close');
      x.addEventListener('click', ev => { ev.stopPropagation(); closeComposer(); });
      head.appendChild(x);
      sheet.appendChild(head);
      const post = el('div', 'xdr-post');
      post.id = 'xdrPost';
      sheet.appendChild(post);
      const sec1 = el('div', 'xdr-sec');
      sec1.appendChild(el('div', 'xdr-lbl', 'Channel'));
      const row1 = el('div', 'xdr-row');
      const srv = el('div', 'xdr-pick');
      srv.id = 'xdrSrv';
      srv.setAttribute('role', 'button');
      srv.setAttribute('tabindex', '0');
      const ch = el('div', 'xdr-pick');
      ch.id = 'xdrCh';
      ch.setAttribute('role', 'button');
      ch.setAttribute('tabindex', '0');
      row1.appendChild(srv);
      row1.appendChild(ch);
      sec1.appendChild(row1);
      sheet.appendChild(sec1);
      const sec2 = el('div', 'xdr-sec');
      sec2.appendChild(el('div', 'xdr-lbl', 'Options'));
      const row2 = el('div', 'xdr-row');
      const seg = el('div', 'xdr-seg');
      const tabB = el('div', null, 'Tab');
      tabB.id = 'xdrModeTab';
      tabB.setAttribute('role', 'button');
      tabB.title = 'Send via Discord browser tab';
      const appB = el('div', null, 'App');
      appB.id = 'xdrModeApp';
      appB.setAttribute('role', 'button');
      appB.title = 'Send via Discord desktop app (Vencord plugin)';
      seg.appendChild(tabB);
      seg.appendChild(appB);
      const preset = el('div', 'xdr-pick');
      preset.id = 'xdrPreset';
      preset.setAttribute('role', 'button');
      preset.setAttribute('tabindex', '0');
      preset.title = 'Ping preset — click to switch';
      const pingT = el('div', 'xdr-toggle');
      pingT.id = 'xdrPingT';
      pingT.setAttribute('role', 'button');
      pingT.title = 'Toggle pings on/off';
      const editB = el('div', 'xdr-toggle', 'Edit');
      editB.id = 'xdrEdit';
      editB.setAttribute('role', 'button');
      editB.title = 'Edit ping presets';
      row2.appendChild(seg);
      row2.appendChild(preset);
      row2.appendChild(pingT);
      row2.appendChild(editB);
      sec2.appendChild(row2);
      const panel = el('div', 'xdr-panel');
      panel.id = 'xdrPanel';
      panel.hidden = true;
      sec2.appendChild(panel);
      sheet.appendChild(sec2);
      const foot = el('div', 'xdr-foot');
      const cancel = el('div', 'xdr-cancel', 'Cancel');
      cancel.setAttribute('role', 'button');
      cancel.addEventListener('click', ev => { ev.stopPropagation(); closeComposer(); });
      const send = el('button', 'xdr-send', 'Send');
      send.id = 'xdrSend';
      send.setAttribute('type', 'button');
      send.addEventListener('click', ev => {
        ev.stopPropagation();
        relay(composer.link, currentEntry(), isPingOn());
        closeComposer();
      });
      foot.appendChild(cancel);
      foot.appendChild(send);
      sheet.appendChild(foot);
      ov.appendChild(sheet);
      ['mousedown', 'click', 'mouseup', 'dblclick', 'auxclick'].forEach(evt =>
        sheet.addEventListener(evt, e => e.stopPropagation()));
      document.documentElement.appendChild(ov);

      srv.addEventListener('click', () => {
        const items = [{ key: '__current', label: 'Open tab', sub: 'current channel', selected: store.sel.server === '__current' }];
        store.servers().forEach(s => items.push({
          key: s.g, label: s.label, sub: store.channelsOf(s.g).length + ' ch',
          selected: store.sel.server === s.g
        }));
        openMenu(srv, items, it => {
          store.sel.server = it.key;
          store.sel.channel = it.key === '__current' ? null : (store.channelsOf(it.key)[0] || null);
          persistTarget();
          refreshComposer();
        });
      });
      ch.addEventListener('click', () => {
        if (store.sel.server === '__current') {
          openMenu(ch, [{ key: 'current', label: 'currently open channel', selected: true }], () => {});
          return;
        }
        const items = store.channelsOf(store.sel.server).map(hh => ({
          key: hh.id, label: chanLabel(hh), selected: store.sel.channel && store.sel.channel.id === hh.id
        }));
        openMenu(ch, items, it => {
          store.sel.channel = store.channelsOf(store.sel.server).find(hh => hh.id === it.key) || null;
          persistTarget();
          refreshComposer();
        });
      });
      tabB.addEventListener('click', () => {
        gset(MODE_KEY, 'tab');
        refreshComposer();
        toast('Tab mode ON — sends go through the Discord browser tab');
      });
      appB.addEventListener('click', () => {
        brokerHealth(ok => {
          gset(MODE_KEY, ok ? 'app' : 'tab');
          refreshComposer();
          toast(ok ? 'App mode ON — sends go through the desktop app' : 'Broker unreachable — staying in Tab mode (start xdr-broker first)', ok ? 'ok' : 'err');
        });
      });
      preset.addEventListener('click', () => {
        const d = getPingData();
        const items = Object.keys(d.presets).map(name => ({
          key: name, label: name, sub: d.presets[name].length + ' users', selected: name === d.active
        }));
        openMenu(preset, items, it => {
          const d2 = getPingData();
          d2.active = it.key;
          setPingData(d2);
          refreshComposer();
        });
      });
      pingT.addEventListener('click', () => {
        const d = getPingData();
        d.on = !(d.on !== false);
        setPingData(d);
        refreshComposer();
      });
      editB.addEventListener('click', () => {
        composer.editOpen = !composer.editOpen;
        refreshComposer();
      });
    }

    function renderPanel(panel) {
      panel.textContent = '';
      const d = getPingData();
      const chips = el('div', 'xdr-chips');
      Object.keys(d.presets).forEach(name => {
        const c = el('div', 'xdr-chip' + (name === d.active ? ' on' : ''), name);
        c.setAttribute('role', 'button');
        c.title = name === d.active ? 'Active preset' : 'Click to make active. Double-click to delete.';
        c.addEventListener('click', ev => {
          ev.stopPropagation();
          if (composer.delArm === name) {
            const names = Object.keys(getPingData().presets);
            if (names.length <= 1) { toast('Cannot delete the last preset', 'err'); return; }
            const d2 = getPingData();
            delete d2.presets[name];
            if (d2.active === name) d2.active = Object.keys(d2.presets)[0];
            setPingData(d2);
            composer.delArm = null;
            refreshComposer();
            toast('Deleted preset "' + name + '"');
          } else {
            const d2 = getPingData();
            d2.active = name;
            setPingData(d2);
            refreshComposer();
          }
        });
        c.addEventListener('dblclick', ev => {
          ev.stopPropagation();
          if (Object.keys(getPingData().presets).length <= 1) { toast('Cannot delete the last preset', 'err'); return; }
          composer.delArm = name;
          refreshComposer();
          toast('Click "' + name + '" again to confirm delete', 'err');
        });
        chips.appendChild(c);
      });
      panel.appendChild(chips);
      if (composer.delArm && !d.presets[composer.delArm]) composer.delArm = null;
      if (composer.delArm) {
        const arm = el('div', 'xdr-lbl', 'Click "' + composer.delArm + '" again to confirm delete, or pick another preset.');
        arm.style.color = '#ff5c7a';
        panel.appendChild(arm);
      }
      const users = d.presets[d.active] || [];
      if (!users.length) panel.appendChild(el('div', 'xdr-lbl', 'No users in "' + d.active + '" — add one below.'));
      users.forEach(u => {
        const row = el('div', 'xdr-urow');
        row.appendChild(el('span', 'n', u.label || u.id));
        row.appendChild(el('span', 'i', u.id));
        const rm = el('span', 'rm', '✕');
        rm.setAttribute('role', 'button');
        rm.setAttribute('aria-label', 'Remove ' + (u.label || u.id));
        rm.addEventListener('click', ev => {
          ev.stopPropagation();
          const d2 = getPingData();
          d2.presets[d2.active] = (d2.presets[d2.active] || []).filter(x => x.id !== u.id);
          setPingData(d2);
          refreshComposer();
        });
        row.appendChild(rm);
        panel.appendChild(row);
      });
      const addRow = el('div', 'xdr-add');
      const inp = document.createElement('input');
      inp.placeholder = 'User ID (17–20 digits, paste several at once)';
      inp.setAttribute('type', 'text');
      inp.setAttribute('data-xdr-input', '1');
      const addB = el('div', 'xdr-btn2', 'Add');
      addB.setAttribute('role', 'button');
      const doAdd = () => {
        const ids = inp.value.trim().split(/[\s,;]+/).filter(s => /^\d{17,20}$/.test(s));
        if (!ids.length) { toast('Paste one or more user IDs (17–20 digits)', 'err'); return; }
        const d2 = getPingData();
        if (!d2.presets[d2.active]) d2.presets[d2.active] = [];
        let added = 0;
        ids.forEach(uid => {
          if (!d2.presets[d2.active].some(x => x.id === uid)) {
            d2.presets[d2.active].push({ id: uid, label: uid });
            added++;
          }
        });
        setPingData(d2);
        refreshComposer();
        toast(added ? ('Added ' + added + ' user(s) to ' + d2.active) : 'Already added or invalid', added ? 'ok' : 'err');
      };
      inp.__xdrEnter = doAdd;
      addB.addEventListener('click', ev => { ev.stopPropagation(); doAdd(); });
      ['mousedown', 'click', 'mouseup'].forEach(evt => inp.addEventListener(evt, e2 => e2.stopPropagation()));
      addRow.appendChild(inp);
      addRow.appendChild(addB);
      panel.appendChild(addRow);
      const newRow = el('div', 'xdr-add');
      const nameInp = document.createElement('input');
      nameInp.placeholder = 'New preset name…';
      nameInp.setAttribute('type', 'text');
      nameInp.setAttribute('data-xdr-input', '1');
      const createB = el('div', 'xdr-btn2', '+ New preset');
      createB.setAttribute('role', 'button');
      const doCreate = () => {
        const name = nameInp.value.trim();
        if (!name) { toast('Preset name required', 'err'); return; }
        const d2 = getPingData();
        if (d2.presets[name]) { toast('Preset already exists', 'err'); return; }
        d2.presets[name] = [];
        d2.active = name;
        setPingData(d2);
        composer.delArm = null;
        refreshComposer();
        toast('Preset "' + name + '" created', 'ok');
      };
      nameInp.__xdrEnter = doCreate;
      createB.addEventListener('click', ev => { ev.stopPropagation(); doCreate(); });
      ['mousedown', 'click', 'mouseup'].forEach(evt => nameInp.addEventListener(evt, e2 => e2.stopPropagation()));
      newRow.appendChild(nameInp);
      newRow.appendChild(createB);
      panel.appendChild(newRow);
    }

    function refreshComposer() {
      const ov = document.getElementById('xdrOverlay');
      if (!ov || ov.hidden) return;
      const d = getPingData();
      const users = d.presets[d.active] || [];
      const post = document.getElementById('xdrPost');
      if (post && composer.link) {
        post.textContent = '';
        const sn = el('div', null, composer.snippet || '');
        post.appendChild(sn);
        const lk = document.createElement('a');
        lk.href = composer.link;
        lk.textContent = composer.link;
        lk.target = '_blank';
        lk.rel = 'noopener';
        post.appendChild(lk);
      }
      const srv = document.getElementById('xdrSrv');
      if (srv) {
        srv.textContent = '';
        srv.appendChild(el('span', 't', srvLabel(store.sel.server)));
        srv.appendChild(el('span', 'c', '▾'));
      }
      const ch = document.getElementById('xdrCh');
      if (ch) {
        ch.textContent = '';
        ch.appendChild(el('span', 't', store.sel.server === '__current' ? 'open channel' : chanLabel(store.sel.channel)));
        ch.appendChild(el('span', 'c', '▾'));
      }
      const isApp = getMode() === 'app';
      const tabB = document.getElementById('xdrModeTab');
      const appB = document.getElementById('xdrModeApp');
      if (tabB) tabB.className = isApp ? '' : 'on';
      if (appB) {
        appB.className = isApp ? 'on' : '';
        appB.style.opacity = (isApp && appAlive === false) ? '.45' : '1';
      }
      const preset = document.getElementById('xdrPreset');
      if (preset) {
        preset.textContent = '';
        preset.appendChild(el('span', 't', '@ ' + d.active + (users.length ? ' (' + users.length + ')' : '')));
        preset.appendChild(el('span', 'c', '▾'));
      }
      const pingT = document.getElementById('xdrPingT');
      if (pingT) {
        const on = d.on !== false;
        pingT.textContent = on ? '● Ping on' : '○ Off';
        pingT.style.color = on ? '#2ecc71' : 'var(--xdr-sub,#536471)';
      }
      const editB = document.getElementById('xdrEdit');
      if (editB) editB.style.color = composer.editOpen ? '#1d9bf0' : '';
      const panel = document.getElementById('xdrPanel');
      if (panel) {
        panel.hidden = !composer.editOpen;
        if (composer.editOpen) renderPanel(panel);
      }
      setSending(!!runXSide.sending);
      refreshSplits();
    }

    function openComposer(link, snippet) {
      ensureCss();
      buildComposer();
      store.readHist();
      reselect();
      composer.link = link || lastTweetUrl || location.href;
      composer.snippet = snippet !== undefined ? snippet : lastTweetText;
      composer.editOpen = false;
      composer.delArm = null;
      closeMenu();
      const ov = document.getElementById('xdrOverlay');
      ov.hidden = false;
      refreshComposer();
      requestAnimationFrame(() => ov.classList.add('open'));
      const s = document.getElementById('xdrSend');
      if (s) s.focus();
    }
    function closeComposer() {
      closeMenu();
      const ov = document.getElementById('xdrOverlay');
      if (ov) { ov.classList.remove('open'); ov.hidden = true; }
    }

    const seenArts = new WeakSet();
    const splits = new Set();
    function goText() {
      let lbl;
      if (store.sel.server === '__current') lbl = 'Open tab';
      else {
        const t = currentEntry();
        if (!t) return 'Pick channel…';
        lbl = chanLabel(t);
        if (lbl.length > 12) lbl = lbl.slice(0, 11) + '…';
      }
      let badge = '';
      try {
        const d = getPingData();
        const n = (d.on !== false) ? ((d.presets[d.active] || []).length) : 0;
        if (n > 0) badge = ' @' + n;
      } catch (e) {}
      return lbl + badge;
    }
    function goTitle() {
      const t = currentEntry();
      const where = t ? (srvLabel(store.sel.server) + ' / ' + chanLabel(t)) : 'no target yet';
      return 'Send to ' + where + ' (' + getMode() + ' mode) — click to send, ▾ for options';
    }
    function paintGo(go) {
      go.textContent = '';
      const ic = document.createElement('span');
      ic.innerHTML = SEND_SVG;
      ic.style.cssText = 'display:flex;align-items:center';
      go.appendChild(ic);
      const tx = document.createElement('span');
      tx.className = 't';
      tx.textContent = goText();
      go.appendChild(tx);
      go.title = goTitle();
    }
    function refreshSplits() {
      for (const s of splits) {
        if (!s.go.isConnected) { splits.delete(s); continue; }
        if (s.go.classList.contains('busy')) continue;
        s.go.classList.remove('ok', 'fail');
        paintGo(s.go);
      }
    }
    function actionRowOf(art) {
      const replyEl = art.querySelector('[data-testid="reply"]') || art.querySelector('[role="group"]');
      let elm = replyEl;
      while (elm && elm !== art) {
        if (elm.children.length >= 3) return elm;
        elm = elm.parentElement;
      }
      return art.lastElementChild;
    }
    function ensureBtn(art) {
      if (!art) return;
      if (art.querySelector(':scope .xdr-split')) { seenArts.add(art); return; }
      const reseen = seenArts.has(art);
      seenArts.delete(art);
      const u = articleUrl(art);
      if (!u) return;
      const row = actionRowOf(art);
      if (!row || !row.isConnected) return;
      const wrap = document.createElement('div');
      wrap.className = 'xdr-split';
      const go = document.createElement('div');
      go.className = 'xdr-go';
      go.setAttribute('role', 'button');
      go.setAttribute('tabindex', '0');
      paintGo(go);
      const chev = document.createElement('div');
      chev.className = 'xdr-chev';
      chev.setAttribute('role', 'button');
      chev.setAttribute('tabindex', '0');
      chev.setAttribute('aria-label', 'Send options');
      chev.title = 'Options: channel, pings, mode';
      chev.textContent = '▾';
      wrap.appendChild(go);
      wrap.appendChild(chev);
      splits.add({ go });
      const fire = () => {
        if (go.classList.contains('busy')) return;
        if (store.sel.server !== '__current' && !currentEntry()) { openComposer(articleUrl(art) || u, articleSnippet(art)); return; }
        go.classList.add('busy');
        go.textContent = '';
        const sp = document.createElement('span');
        sp.className = 'xdr-spin';
        go.appendChild(sp);
        const tx = document.createElement('span');
        tx.className = 't';
        tx.textContent = 'Sending…';
        go.appendChild(tx);
        relay(articleUrl(art) || u, currentEntry(), isPingOn(), ok => {
          go.classList.remove('busy');
          go.classList.add(ok ? 'ok' : 'fail');
          if (ok) {
            go.textContent = '✓ Sent';
            setTimeout(() => { paintGo(go); go.classList.remove('ok'); }, 1500);
          } else {
            go.textContent = '↻ Retry';
            go.title = 'Send failed — click to retry';
          }
        });
      };
      go.addEventListener('click', ev => {
        ev.stopPropagation();
        ev.preventDefault();
        if (go.classList.contains('fail')) { go.classList.remove('fail'); paintGo(go); }
        fire();
      });
      go.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.stopPropagation();
          ev.preventDefault();
          fire();
        }
      });
      chev.addEventListener('click', ev => {
        ev.stopPropagation();
        ev.preventDefault();
        openComposer(articleUrl(art) || u, articleSnippet(art));
      });
      chev.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.stopPropagation();
          ev.preventDefault();
          openComposer(articleUrl(art) || u, articleSnippet(art));
        }
      });
      wrap.addEventListener('contextmenu', ev => {
        if (gget('xdr.pillHidden', '') === '1') {
          ev.preventDefault();
          ev.stopPropagation();
          gset('xdr.pillHidden', '0');
          makePill();
          toast('Quick-send pill restored');
        }
      });
      ['mousedown', 'click', 'mouseup', 'dblclick', 'auxclick'].forEach(evt =>
        wrap.addEventListener(evt, e => e.stopPropagation()));
      row.appendChild(wrap);
      seenArts.add(art);
      if (reseen) healCount++;
      const statusPath = (location.pathname.match(/^\/[^/]+\/status\/\d+/) || [])[0];
      try {
        if (statusPath && new URL(u, location.origin).pathname.startsWith(statusPath)) art.setAttribute('data-xdr-main', '1');
        else art.removeAttribute('data-xdr-main');
      } catch (e) {}
    }
    function ensureAll() {
      let arts = document.querySelectorAll('article[data-testid="tweet"]');
      if (!arts.length) arts = document.querySelectorAll('article');
      for (const art of arts) ensureBtn(art);
    }

    let rafQueued = false;
    const pendingArts = new Set();
    function drainQueue() {
      rafQueued = false;
      for (const n of pendingArts) {
        if (n.isConnected) {
          if (n.matches && n.matches('article')) ensureBtn(n);
          if (n.querySelectorAll) {
            const inner = n.querySelectorAll('article[data-testid="tweet"],article');
            for (const a of inner) ensureBtn(a);
          }
        }
      }
      pendingArts.clear();
    }
    function onMut(recs) {
      for (const rec of recs) {
        for (const n of rec.addedNodes) {
          if (n.nodeType !== 1) continue;
          pendingArts.add(n);
        }
      }
      if (!rafQueued && pendingArts.size) {
        rafQueued = true;
        requestAnimationFrame(drainQueue);
      }
    }

    function makePill() {
      if (gget('xdr.pillHidden', '') === '1') return;
      if (document.getElementById('xdrPill')) return;
      ensureCss();
      const dark = document.documentElement.getAttribute('data-xdr-theme') === 'dark';
      const p = document.createElement('div');
      p.id = 'xdrPill';
      p.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:7px 8px 7px 14px;border-radius:999px;cursor:pointer;font:600 13px system-ui,sans-serif;color:' + (dark ? '#e7e9ea' : '#0f1419') + ';background:' + (dark ? '#1e2126' : '#ffffff') + ';border:1px solid ' + (dark ? '#2f3336' : '#eff3f4') + ';box-shadow:0 6px 20px rgba(0,0,0,.2);user-select:none';
      const ic = document.createElement('span');
      ic.innerHTML = SEND_SVG;
      ic.style.cssText = 'display:flex;align-items:center;color:#1d9bf0';
      const lbl = document.createElement('span');
      lbl.textContent = 'Discord';
      const xx = document.createElement('span');
      xx.textContent = '✕';
      xx.setAttribute('role', 'button');
      xx.style.cssText = 'display:flex;align-items:center;justify-content:center;min-width:18px;height:18px;border-radius:50%;cursor:pointer;font-size:11px;font-weight:800;color:' + (dark ? '#71767b' : '#536471');
      xx.addEventListener('click', ev => {
        ev.stopPropagation();
        gset('xdr.pillHidden', '1');
        p.remove();
        toast('Quick-send pill hidden — right-click a post button to bring it back');
      });
      p.appendChild(ic);
      p.appendChild(lbl);
      p.appendChild(xx);
      p.addEventListener('click', ev => { ev.stopPropagation(); if (quickFresh()) relay(null, currentEntry(), isPingOn()); });
      document.documentElement.appendChild(p);
    }

    ensureCss();
    applyTheme();
    let themeTimer = 0;
    const themeObs = new MutationObserver(() => {
      clearTimeout(themeTimer);
      themeTimer = setTimeout(applyTheme, 500);
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    try { themeObs.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] }); } catch (e) {}
    try {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    } catch (e) {}

    const feedObs = new MutationObserver(onMut);
    try {
      feedObs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    ensureAll();
    setTimeout(ensureAll, 2500);
    setInterval(ensureAll, 10000);

    GM_addValueChangeListener(HIST_KEY, (name, oldV, newV, remote) => {
      if (!remote) return;
      store.readHist();
      store.histV++;
      reselect();
      refreshSplits();
      refreshComposer();
    });
    GM_addValueChangeListener(PING_PRESET_KEY, (name, oldV, newV, remote) => {
      if (!remote) return;
      refreshSplits();
      refreshComposer();
    });
    setInterval(sweepStale, 60000);
    sweepStale();
    if (document.documentElement) makePill(); else setTimeout(makePill, 300);
    W.addEventListener('keydown', e => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyD') {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault(); e.stopPropagation();
        if (quickFresh()) relay(lastTweetUrl, currentEntry(), isPingOn());
      }
    }, true);
    W.__xdrXReport = () => {
      const ov = document.getElementById('xdrOverlay');
      return {
        v: '1.10.0', mode: getMode(), url: location.href,
        articles: document.querySelectorAll('article[data-testid="tweet"]').length,
        articlesBare: document.querySelectorAll('article').length,
        splits: document.querySelectorAll('.xdr-split').length,
        heals: healCount, queueDepth: pendingArts.size,
        testids: {
          reply: !!document.querySelector('[data-testid="reply"]'),
          tweetText: !!document.querySelector('[data-testid="tweetText"]'),
          timeLink: !!document.querySelector('a[href*="/status/"] time')
        },
        lastHover: lastTweetUrl, lastHoverAgeMs: lastHoverTs ? Date.now() - lastHoverTs : -1,
        sel: store.sel, histLen: store.hist.length,
        theme: document.documentElement.getAttribute('data-xdr-theme'),
        menu: !!menu, composer: !!(ov && !ov.hidden)
      };
    };
    console.debug('[xdr] X side active v1.10.0');
  }

  // ---------------- Discord side ----------------
  function runDiscordSide() {
    const ME = Math.random().toString(36).slice(2);

    // ===== webpack capture =====
    // Discord ships several webpack runtimes over one chunk array; a plain
    // wrapper hook dies when a later runtime re-assigns push, and an accessor
    // hook at document-start corrupted boot on this setup. So: PLAIN fake-chunk
    // probes only, validated via the main-runtime marker ("b" in r). When only
    // the small runtime answers, the factory-scan rescue still finds modules.
    const reqs = new Set();
    let mainReq = null;
    let MessageActions = null, maVia = 'none';

    function onRequire(r) {
      if (!r || !r.c) return;
      if (!reqs.has(r)) reqs.add(r);
      if ('b' in r && !mainReq) {
        mainReq = r;
        console.debug('[xdr] main webpack runtime captured: ' + Object.keys(r.c).length + ' cached, ' + (r.m ? Object.keys(r.m).length : 0) + ' factories');
      }
      if (!MessageActions) findMessageActions();
    }

    function probe() {
      try {
        const chunks = W.webpackChunkdiscord_app || W.webpackChunkdiscord_www;
        if (chunks && typeof chunks.push === 'function') {
          chunks.push([['xdr' + Math.random()], {}, onRequire]);
        }
      } catch (e) {}
    }

    function legacyProbe() {
      try {
        for (const n of Object.keys(W).filter(k => /^webpackChunk/.test(k))) {
          const chunks = W[n];
          if (!chunks || typeof chunks.push !== 'function') continue;
          for (let i = 0; i < 4; i++) chunks.push([['xdr' + Math.random()], {}, onRequire]);
        }
      } catch (e) {}
    }

    function isActionsLike(o) {
      return !!o && typeof o.sendMessage === 'function' &&
        (typeof o.editMessage === 'function' || typeof o.receiveMessage === 'function');
    }
    function scanCache(r) {
      if (!r || !r.c) return null;
      for (const k in r.c) {
        const ex = r.c[k] && r.c[k].exports;
        if (!ex) continue;
        if (isActionsLike(ex)) return ex;
        if (ex.default && isActionsLike(ex.default)) return ex.default;
      }
      return null;
    }
    // Vencord-style rescue: the runtime we captured often holds THOUSANDS of
    // app factories in r.m (registered via shared chunk pushes) even when its
    // executed cache is tiny. Match factory source text, then targeted-require.
    function execFromFactories(r, srcPred, exportPred) {
      if (!r || !r.m) return null;
      for (const id of Object.keys(r.m)) {
        let src;
        try { src = String(r.m[id]); } catch (e) { continue; }
        if (!srcPred(src)) continue;
        try {
          const ex = r(id);
          if (exportPred(ex)) return ex;
          if (ex && exportPred(ex.default)) return ex.default;
        } catch (e) {}
      }
      return null;
    }
    function scanFactories(r) {
      return execFromFactories(r,
        src => /sendMessage\s*[:(]/.test(src) && /(editMessage|receiveMessage)\s*[:(]/.test(src),
        isActionsLike);
    }
    function findMessageActions() {
      if (MessageActions) return MessageActions;
      if (mainReq) {
        const hit = scanCache(mainReq);
        if (hit) { MessageActions = hit; maVia = 'cache'; console.debug('[xdr] MessageActions via main cache'); return hit; }
      }
      for (const r of reqs) {
        const hit = scanCache(r);
        if (hit) { MessageActions = hit; maVia = 'cache*'; console.debug('[xdr] MessageActions via runtime cache'); return hit; }
      }
      const list = mainReq ? [mainReq, ...reqs] : [...reqs];
      for (const r of list) {
        const hit = scanFactories(r);
        if (hit) { MessageActions = hit; maVia = 'factory'; console.debug('[xdr] MessageActions via factory scan'); return hit; }
      }
      return null;
    }

    function currentChannel() {
      const m = location.pathname.match(/^\/channels\/(?:\d+|@me)\/(\d+)/);
      return m ? m[1] : null;
    }

    // composer: scoped and unambiguous — never the search box or an edit modal
    function composer() {
      const scoped = document.querySelectorAll('[role="textbox"][aria-label^="Message" i]');
      if (scoped.length === 1) return scoped[0];
      const all = document.querySelectorAll('[role="textbox"]');
      return all.length === 1 ? all[0] : null;
    }
    function channelLabel() {
      const box = composer();
      const lbl = (box && box.getAttribute('aria-label')) || '';
      return lbl.replace(/^Message\s+/i, '');
    }

    // ---- channel history (with server identity) ----
    function guildIconFrom(item) {
      const cdnRe = /cdn\.discord(app)?\.com/;
      const img = item && item.querySelector('img');
      if (img && img.src && cdnRe.test(img.src)) return img.src;
      if (!item) return '';
      for (const el of [item, ...item.querySelectorAll('div,span')]) {
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === 'none') continue;
        const m = bg.match(/url\("?([^")]+)"?\)/);
        if (m && cdnRe.test(m[1])) return m[1];
      }
      return '';
    }
    function unwrapExports(ex) {
      if (!ex) return null;
      if (typeof ex.getGuild === 'function') return ex;
      for (const k of ['default', 'Z', 'ZP']) {
        if (ex[k] && typeof ex[k].getGuild === 'function') return ex[k];
      }
      return null;
    }

    function guildMeta(guild) {
      if (guild === '@me') return { gname: 'Direct Messages', gicon: '' };
      let domName = '', domIcon = '';
      let item = document.querySelector('[data-list-item-id="guildsnav_' + guild + '"]');
      if (!item) item = document.querySelector('[data-list-item-id*="' + guild + '"]');
      if (item) {
        domName = item.getAttribute('aria-label') || item.getAttribute('data-dnd-name') || item.getAttribute('title') || '';
        domName = domName.replace(/,?\s*\d*\s*unread.*$/i, '').replace(/,?\s*\d*\s*mention.*$/i, '').trim();
        if (!domName) {
          const txt = (item.textContent || '').trim();
          if (txt && txt.length < 60) domName = txt.replace(/\d+$/, '').trim();
        }
        domIcon = guildIconFrom(item);
      }
      if (domName && domIcon) return { gname: domName, gicon: domIcon };
      try {
        const list = mainReq ? [mainReq, ...reqs] : [...reqs];
        for (const rr of list) {
          if (!rr) continue;
          let gs = null;
          if (rr.c) {
            for (const k in rr.c) {
              const ex = rr.c[k] && rr.c[k].exports;
              gs = unwrapExports(ex);
              if (gs) break;
            }
          }
          if (!gs) {
            const raw = execFromFactories(rr,
              src => /getGuild\s*[:(]/.test(src) && /getGuilds\s*[:(]/.test(src),
              ex => !!unwrapExports(ex));
            gs = unwrapExports(raw);
          }
          if (!gs) continue;
          const g = gs.getGuild(guild);
          if (g) {
            const storeName = g.name || '';
            const ext = String(g.icon || '').startsWith('a_') ? '.gif' : '.png';
            const storeIcon = g.icon ? ('https://cdn.discordapp.com/icons/' + guild + '/' + g.icon + ext + '?size=64') : '';
            return { gname: domName || storeName, gicon: domIcon || storeIcon };
          }
        }
      } catch (e) {}
      return { gname: domName, gicon: domIcon };
    }

    function pushHistory(e) {
      if (!e || !e.id) return;
      let h = []; try { h = JSON.parse(gget(HIST_KEY, '[]')) || []; } catch (err) {}
      if (!Array.isArray(h)) h = [];
      h = h.filter(x => x && x.id !== e.id);
      h.unshift({ id: e.id, guild: e.guild || null, name: e.name || '', gname: e.gname || '', gicon: e.gicon || '', ts: Date.now() });
      h = h.slice(0, 6);
      gset(HIST_KEY, JSON.stringify(h));
    }

    let lastPath = null;
    let histTimer = 0;
    setInterval(() => {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      const m = location.pathname.match(/^\/channels\/(\d+|@me)\/(\d+)/);
      if (!m) return;
      const ch = m[2], guild = m[1], token = location.pathname;
      clearTimeout(histTimer);
      histTimer = setTimeout(() => {           // let the composer label + guild rail settle
        if (location.pathname !== token || currentChannel() !== ch) return;
        let name = channelLabel();
        if (!name) { const t = document.title.match(/#([^\s|#]+)/); if (t) name = t[1]; }
        const meta = guildMeta(guild);
        pushHistory({ id: ch, guild, name: name || '', gname: meta.gname, gicon: meta.gicon });
      }, 1800);
    }, 1000);

    // backfill server names/icons for entries recorded by older versions
    setInterval(() => {
      let h; try { h = JSON.parse(gget(HIST_KEY, '[]')); } catch (e) { return; }
      if (!Array.isArray(h) || !h.length) return;
      let changed = false;
      for (const e of h) {
        if (!e || !e.guild || e.guild === '@me' || (e.gname && e.gicon)) continue;
        const meta = guildMeta(e.guild);
        if (!e.gname && meta.gname) { e.gname = meta.gname; changed = true; }
        if (!e.gicon && meta.gicon) { e.gicon = meta.gicon; changed = true; }
      }
      if (changed) gset(HIST_KEY, JSON.stringify(h));
    }, 4000);

    // ---- send paths ----
    function pollUntil(fn, timeout, step) {
      return new Promise(res => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          let v = false;
          try { v = fn(); } catch (e) {}
          if (v) { clearInterval(iv); res(true); }
          else if (Date.now() - t0 > timeout) { clearInterval(iv); res(false); }
        }, step);
      });
    }

    // Exactly ONE paste per call. Every step is verified by POLLING (Slate
    // applies edits asynchronously; instant checks race and caused duplicate
    // pastes). No internal retry loop — a failed composer send surfaces as a
    // failure instead of pasting again.
    async function domSend(text) {
      const box = composer();
      if (!box) return false;
      if ((box.textContent || '').trim() !== '') {
        console.debug('[xdr] composer occupied — not touching your draft');
        return 'OCCUPIED';
      }
      box.focus();
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      } catch (e) { return false; }
      if (!await pollUntil(() => (box.textContent || '').includes(text.slice(0, 24)), 2000, 50)) {
        console.debug('[xdr] paste did not land');
        return false;
      }
      const pressEnter = () => {
        box.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
      };
      const btn = Array.from(document.querySelectorAll('[role="button"][aria-label], button[aria-label]'))
        .find(b => /^send$/i.test(b.getAttribute('aria-label') || ''));
      if (btn) btn.click(); else pressEnter();
      const flushed = await pollUntil(() => (box.textContent || '').trim() === '', 1200, 50);
      console.debug('[xdr] domSend flushed=' + flushed);
      return flushed;
    }


    // internals send: await the returned promise; rejection = failure, one retry.
    // NOTE: the promise resolves on DISPATCH, not delivery — a resolved value is
    // "handed to the client", not server-confirmed.
    async function clientSend(channelId, content) {
      const ma = findMessageActions();
      if (!ma) return null;
      const nonce = String(Date.now()) + String(Math.floor(Math.random() * 1000000));
      const payload = { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [], nonce };
      for (let i = 0; i < 2; i++) {
        try {
          const p = ma.sendMessage(channelId, payload, true, {});
          if (p && typeof p.then === 'function') await p;
          return 'client(' + maVia + ')';
        } catch (e) {
          console.debug('[xdr] client send attempt ' + (i + 1) + ' failed', e);
        }
      }
      return null;
    }
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // SPA route change without reload (Discord's router listens to popstate).
    // Readiness is polled, never slept on: pathname here, composer remount
    // at the call site via the aria-label gate.
    async function spaNavigate(path) {
      try {
        window.history.pushState({}, '', path);
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      } catch (e) {}
      return pollUntil(() => location.pathname === path, 1500, 50);
    }

    // DOM-primary send: the internal sendMessage call resolves on DISPATCH,
    // not delivery (proven: it "succeeds" even logged out) — so for real
    // delivery we do what a user does: switch to the channel, paste, send,
    // switch back. Refuses to paste unless the composer provably shows the
    // target channel, so wrong-channel sends are impossible.
    async function sendToChannel(channelId, guild, content, chName) {
      const back = location.pathname;
      const isOpen = currentChannel() === channelId;
      if (!isOpen) {
        if (!guild) {
          return clientSend(channelId, content);
        }
        const targetPath = '/channels/' + guild + '/' + channelId;
        const okNav = await spaNavigate(targetPath);
        const want = String(chName || '').replace(/^#/, '').trim();
        const verified = okNav && await pollUntil(() => {
          const box = composer();
          const label = (box && box.getAttribute('aria-label')) || '';
          return box && (!want || label.toLowerCase().includes(want.toLowerCase()));
        }, 4000, 50);
        if (!verified) {
          console.debug('[xdr] nav-verify failed (want="' + want + '") — not pasting');
          if (location.pathname === targetPath) await spaNavigate(back);
          return clientSend(channelId, content);
        }
        const sent = await domSend(content);
        if (location.pathname === targetPath) await spaNavigate(back);
        if (sent === 'OCCUPIED') return 'OCCUPIED';
        return sent ? 'dom-nav' : 'DOMFAIL';
      }
      const r = await domSend(content);
      if (r === 'OCCUPIED') return 'OCCUPIED';
      return r ? 'dom' : 'DOMFAIL';
    }

    // leader election: exactly ONE discord tab answers relay requests.
    // Qualified = a channel is open in this tab. Jittered ticks reduce the
    // read-then-write race between simultaneously-ticking tabs.
    let isLeader = false;
    function electionTick() {
      const qual = !!currentChannel();
      const raw = gget(PING_KEY, '');
      const parts = raw.split(':');
      const id = parts[0] || '';
      const ts = Number(parts[1]) || 0;
      const leaderQualified = parts[2] === 'q';
      const fresh = (Date.now() - ts) < 5000;
      const take = (qual && (!fresh || !leaderQualified || id === ME)) || (!qual && (!fresh || id === ME));
      if (take) {
        gset(PING_KEY, ME + ':' + Date.now() + (qual ? ':q' : ''));
        // confirm ownership after the write (read-then-write races otherwise)
        isLeader = gget(PING_KEY, '').startsWith(ME + ':');
      } else {
        isLeader = false;
      }
    }
    setTimeout(() => { electionTick(); setInterval(electionTick, 2000); }, 200 + Math.random() * 400);

    W.__xdrReport = () => ({
      url: location.href, leader: isLeader, internals: !!MessageActions, matcher: maVia,
      mainRuntime: !!mainReq,
      runtimes: [...reqs].map(r => ({ c: r.c ? Object.keys(r.c).length : 0, m: r.m ? Object.keys(r.m).length : 0, main: 'b' in r }))
    });

    let lastReqId = null;
    let handling = false;
    const reqQueue = [];
    function queueAck(req, o) {
      gset(ackKey(req.id), JSON.stringify(Object.assign({ ts: Date.now() }, o)));
    }
    function pumpQueue() {
      if (handling) return;
      const req = reqQueue.shift();
      if (!req) return;
      if (!gget(PING_KEY, '').startsWith(ME + ':')) {
        queueAck(req, { ok: false, err: 'leadership lost before handling' });
        pumpQueue();
        return;
      }
      handling = true;
      handleRelay(req, () => { handling = false; pumpQueue(); });
    }
    GM_addValueChangeListener(REQ_KEY, (name, oldV, newV, remote) => {
      if (!remote || !isLeader) return;
      let req; try { req = JSON.parse(newV); } catch (e) { return; }
      if (!req || !req.id || req.id === lastReqId) return;
      if (gget(lockKey(req.id), '')) return;
      gset(lockKey(req.id), ME + ':' + Date.now());
      if (!gget(lockKey(req.id), '').startsWith(ME + ':')) return;
      lastReqId = req.id;
      reqQueue.push(req);
      if (reqQueue.length > 3) {
        const dropped = reqQueue.shift();
        queueAck(dropped, { ok: false, err: 'relay busy — too many at once, retry' });
      }
      pumpQueue();
    });

    async function handleRelay(req, done) {
      const ack = o => {
        queueAck(req, o);
        try { if (done) done(); } catch (e) {}
      };
      const finish = () => { try { if (done) done(); } catch (e) {} };
      if (!gget(lockKey(req.id), '').startsWith(ME + ':')) { finish(); return; }
      if (gget(ackKey(req.id), '')) { finish(); return; }
      if (!req.ts || Date.now() - req.ts > 15000) { ack({ ok: false, err: 'request expired' }); return; }
      if (!gget(PING_KEY, '').startsWith(ME + ':')) { ack({ ok: false, err: 'leadership lost mid-flight' }); return; }
      const ch = req.ch || currentChannel();
      if (!ch) { ack({ ok: false, err: 'no channel open — click into a channel in this tab first' }); return; }
      if (req.ch && !req.chG && !findMessageActions()) {
        ack({ ok: false, err: 'no guild recorded for that channel — open it once in Discord, then retry', at: location.pathname });
        return;
      }
      let content = req.link;
      const pings = Array.isArray(req.pingUsers) ? req.pingUsers.filter(id => /^\d{17,20}$/.test(id)) : [];
      if (pings.length) content += ' ' + pings.map(id => '<@' + id + '>').join(' ');
      const t0 = Date.now();
      (function attempt() {
        sendToChannel(ch, req.chG || null, content, req.chName).then(via => {
          if (via && via !== 'DOMFAIL' && via !== 'OCCUPIED') {
            ack({ ok: true, ch, chName: req.chName || channelLabel(), via });
            console.debug('[xdr] sent via ' + via + ' to ' + ch);
          } else if (via === 'DOMFAIL') {
            ack({ ok: false, ch, err: 'composer send failed — the link may still be sitting in the composer; press Enter manually or clear it' });
          } else if (via === 'OCCUPIED') {
            ack({ ok: false, ch, err: 'composer has your draft — clear it first, then retry' });
          } else if (Date.now() - t0 < 10000) {
            if (!gget(PING_KEY, '').startsWith(ME + ':')) {
              ack({ ok: false, err: 'leadership lost during retry', ts: Date.now() });
              return;
            }
            setTimeout(attempt, 800);
          } else {
            ack({ ok: false, err: 'send failed — reload the Discord tab and retry' });
          }
        });
      })();
    }
    sweepStale();
    setInterval(sweepStale, 60000);
    probe();
    legacyProbe();
    findMessageActions();
    const warm = setInterval(() => {
      if (MessageActions) { clearInterval(warm); return; }
      if (!mainReq) { probe(); legacyProbe(); }
      findMessageActions();
    }, 3000);

    console.debug('[xdr] Discord side active v1.10.0');
  }

  // ---------------- dispatch ----------------
  const host = location.hostname;
  if (host === 'discord.com' || host === 'ptb.discord.com' || host === 'canary.discord.com') runDiscordSide();
  else runXSide();
})();
