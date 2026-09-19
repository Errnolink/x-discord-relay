// ==UserScript==
// @name         X → Discord Relay (fixupx)
// @namespace    xdr.local
// @version      1.8.0
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
  function sweepStale() {
    try {
      if (typeof GM_listValues !== 'function' || typeof GM_deleteValue !== 'function') return;
      const now = Date.now();
      for (const k of GM_listValues()) {
        if (!k.startsWith('xdr.ack.') && !k.startsWith('xdr.lock.')) continue;
        const v = gget(k, '');
        let ts = 0;
        try { ts = JSON.parse(v).ts || 0; } catch (e) { const m = v.match(/:(\d{12,})/); if (m) ts = +m[1]; }
        if (ts && now - ts > 60000) GM_deleteValue(k);
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
    const SEND_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';
    const TARGET_KEY = 'xdr.target';

    let lastTweetUrl = null;

    function getPingData() {
      try {
        const d = JSON.parse(gget(PING_PRESET_KEY, '{}'));
        if (d && d.presets) return d;
      } catch (e) {}
      return { presets: { Default: [] }, active: 'Default', on: true };
    }
    function setPingData(d) { gset(PING_PRESET_KEY, JSON.stringify(d)); }
    function getActiveUsers() {
      const d = getPingData();
      return (d.presets[d.active] || []);
    }
    function isPingOn() { return getPingData().on !== false; }
    function addPingUser(preset, id, label) {
      id = String(id).trim();
      if (!id || !/^\d{17,20}$/.test(id)) return false;
      const d = getPingData();
      if (!d.presets[preset]) d.presets[preset] = [];
      if (d.presets[preset].some(u => u.id === id)) return false;
      d.presets[preset].push({ id, label: (label || '').trim() || id });
      setPingData(d);
      return true;
    }
    function removePingUser(preset, id) {
      const d = getPingData();
      if (!d.presets[preset]) return;
      d.presets[preset] = d.presets[preset].filter(u => u.id !== id);
      setPingData(d);
    }

    // permalink of a tweet <article>: prefer the anchor wrapping the <time> element
    // (logged-in layout); logged-out layout has plain text timestamps, so fall back
    // to the first anchor whose href is exactly /user/status/id
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

    function history() {
      try { const h = JSON.parse(gget(HIST_KEY, '[]')); return Array.isArray(h) ? h : []; } catch (e) { return []; }
    }
    function chanLabel(hh) {
      if (!hh) return 'open channel';
      return (hh.name && hh.name[0] === '#') ? hh.name
        : ((hh.guild === '@me') ? (hh.name || hh.id) : '#' + (hh.name || hh.id));
    }
    function setSending(v) {
      runXSide.sending = v;
      for (const b of (runXSide.bars || new Set())) { if (b.setSending) b.setSending(v); }
    }

    function styleEl(el, css) { Object.keys(css).forEach(p => el.style.setProperty(p, css[p])); }

    // match X's light/dark theme so the bar blends in
    function xTheme() {
      try {
        const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
        if (m && m.length >= 3) return (+m[0] * .299 + +m[1] * .587 + +m[2] * .114) < 128 ? 'dark' : 'light';
      } catch (e) {}
      return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    // server icons: x.com CSP blocks cdn.discordapp.com in <img>, so fetch the
    // bytes via GM_xmlhttpRequest and paint them into a canvas instead.
    const iconCache = new Map();
    function iconBitmap(url) {
      if (iconCache.has(url)) return Promise.resolve(iconCache.get(url));
      return new Promise(resolve => {
        let settled = false;
        const done = v => { if (!settled) { settled = true; if (v) iconCache.set(url, v); resolve(v); } };
        const fetchLive = () => {
          try {
            GM_xmlhttpRequest({
              method: 'GET', url, responseType: 'blob', timeout: 8000,
              onload: r => {
                const b = r.response;
                if (!b || !b.size) return done(null);
                createImageBitmap(b).then(bm => {
                  done(bm);
                  try { // persist as data URL for future page loads (24h TTL)
                    const fr = new FileReader();
                    fr.onload = () => {
                      try {
                        const store = JSON.parse(gget('xdr.icons', '{}')) || {};
                        store[url] = { d: fr.result, ts: Date.now() };
                        gset('xdr.icons', JSON.stringify(store));
                      } catch (e) {}
                    };
                    fr.readAsDataURL(b);
                  } catch (e) {}
                }, () => done(null));
              },
              onerror: () => done(null),
              ontimeout: () => done(null)
            });
          } catch (e) { done(null); }
        };
        try { // stored data URL?
          const store = JSON.parse(gget('xdr.icons', '{}')) || {};
          const e2 = store[url];
          if (e2 && e2.d && Date.now() - (e2.ts || 0) < 86400000) {
            fetch(e2.d).then(r => r.blob()).then(b => createImageBitmap(b)).then(done, fetchLive);
            return;
          }
        } catch (e) {}
        fetchLive();
      });
    }
    function paintIcon(holder, hh, size) {
      size = size || 22;
      if (!hh || !hh.gicon) return;
      iconBitmap(hh.gicon).then(bm => {
        if (!bm || !holder.isConnected) return;
        const cv = document.createElement('canvas');
        cv.width = size; cv.height = size;
        cv.getContext('2d').drawImage(bm, 0, 0, size, size);
        cv.style.setProperty('border-radius', '50%');
        holder.replaceChildren(cv);
      });
    }

    // ---- last send target (persisted) ----
    function getTarget() {
      try { const t = JSON.parse(gget(TARGET_KEY, 'null')); if (t && t.id) return t; } catch (e) {}
      return history()[0] || null;
    }

    // ---- desktop-app transport (Vencord plugin via local broker) ----
    // GM storage can't cross browser↔app; in App mode the request goes over
    // HTTP to the local broker (127.0.0.1:8765), which the Vencord plugin
    // polls. Tab mode (GM storage) stays the default and is untouched.
    const MODE_KEY = 'xdr.mode';
    const BROKER = 'http://127.0.0.1:8765';
    let appAlive = null; // null = unchecked, true/false = last health result
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
    function appRelay(payload) {
      const x = gmXhr();
      if (!x) { toast('App mode needs Tampermonkey GM_xmlhttpRequest', 'err'); return; }
      const ackUrl = BROKER + '/ack/' + payload.id;
      x({
        method: 'POST', url: BROKER + '/req', timeout: 4000,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        onload: r => {
          if (r.status !== 200) { setSending(false); toast('Broker rejected request: ' + r.responseText, 'err'); return; }
          const t0 = Date.now();
          const iv = setInterval(() => {
            x({
              method: 'GET', url: ackUrl, timeout: 2500,
              onload: rr => {
                if (rr.status === 200 && rr.responseText) {
                  clearInterval(iv);
                  let ack = {}; try { ack = JSON.parse(rr.responseText); } catch (e) {}
                  if (ack.ok) toast('Sent to ' + (ack.chName || ('channel ' + ack.ch)) + ' ✓ via app' + (ack.via === 'app-verified' ? '' : ' (unverified)'), 'ok');
                  else toast('Discord app: ' + (ack.err || 'unknown error'), 'err');
                  setSending(false);
                } else if (Date.now() - t0 > 12000) {
                  clearInterval(iv);
                  toast('Discord app did not answer. Is the xdrRelay plugin enabled in Vencord?', 'err');
                  setSending(false);
                }
              },
              onerror: () => { if (Date.now() - t0 > 12000) { clearInterval(iv); toast('Broker unreachable mid-poll', 'err'); setSending(false); } },
              ontimeout: () => { if (Date.now() - t0 > 12000) { clearInterval(iv); toast('Broker timeout mid-poll', 'err'); setSending(false); } }
            });
          }, 500);
        },
        onerror: () => { setSending(false); toast('Broker unreachable — is xdr-broker running?', 'err'); },
        ontimeout: () => { setSending(false); toast('Broker timeout — is xdr-broker running?', 'err'); }
      });
    }
    function setTarget(t) { gset(TARGET_KEY, JSON.stringify(t)); }

    function relay(rawUrl, target, ping) {
      setSending(true);
      const url = rawUrl || lastTweetUrl || location.href;
      const link = fixupLink(url);
      if (!link) { toast('No post permalink found (hover a post first, or use its timestamp link)', 'err'); return; }

      const id = (crypto.randomUUID ? crypto.randomUUID() : 'r' + Date.now() + Math.random()).replace(/[^a-z0-9]/gi, '');
      const pingUsers = ping ? getActiveUsers().map(u => u.id) : [];
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
        // desktop-app transport: hand off to the broker (and to the Vencord
        // plugin behind it). No GM keys are written for this request.
        if (appAlive === false) {
          toast('App mode: broker not reachable. Start xdr-broker, or click the mode chip to switch back to Tab mode.', 'err');
          setSending(false);
          return;
        }
        appRelay(payload);
        return;
      }

      gset(ackKey(id), '');
      gset(lockKey(id), '');
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
          gset(key, ''); gset(lockKey(id), ''); setSending(false);
        } else if (Date.now() - t0 > 12000) {
          clearInterval(iv);
          toast('No Discord tab answered. Open discord.com in a browser tab and click into a channel first.', 'err');
          gset(key, ''); gset(lockKey(id), ''); setSending(false);
        }
      }, 120);
    }

    // hover tracking (fallback targeting when bars can't be built)
    document.addEventListener('mouseover', e => {
      const el = e.target;
      if (!el || !el.closest) return;
      const art = el.closest('article[data-testid="tweet"]') || el.closest('article');
      if (art) { const u = articleUrl(art); if (u) lastTweetUrl = u; }
    }, true);

    // ---- dropdown popover: ONE per page (not per bar), X-themed ----
    let pop = null;
    function closePop() { if (pop) { pop.remove(); pop = null; } }
    let popSuppress = 0;
    function openPop(anchor, items, onPick) {
      if (Date.now() < popSuppress) return; // same-chip click: toggle closed, don't reopen
      closePop();
      const dark = xTheme() === 'dark';
      const C = dark
        ? { text: '#e7e9ea', sub: '#71767b', line: '#2f3336', hover: 'rgba(29,155,240,.1)', accent: '#1d9bf0' }
        : { text: '#0f1419', sub: '#536471', line: '#eff3f4', hover: 'rgba(29,155,240,.1)', accent: '#1d9bf0' };
      const p = document.createElement('div');
      styleEl(p, {
        position: 'fixed', 'z-index': '2147483646', 'min-width': '180px', 'max-width': '260px',
        padding: '4px', background: dark ? '#1e2126' : '#fff',
        border: '1px solid ' + C.line, 'border-radius': '14px',
        'box-shadow': '0 8px 28px rgba(0,0,0,' + (dark ? '.6' : '.25') + ')',
        font: '13px system-ui, -apple-system, "Segoe UI", sans-serif'
      });
      items.forEach(it => {
        const row = document.createElement('div');
        styleEl(row, { display: 'flex', 'align-items': 'center', gap: '8px',
          padding: '8px 10px', 'border-radius': '8px', cursor: 'pointer', color: C.text });
        const ic = document.createElement('div');
        styleEl(ic, { width: '20px', height: '20px', 'border-radius': '50%', overflow: 'hidden',
          display: 'flex', 'align-items': 'center', 'justify-content': 'center', flex: '0 0 20px',
          'font-size': '10px', 'font-weight': '700', color: '#fff' });
        const seed = it.iconSeed || it.label || '?';
        const hue = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
        ic.style.setProperty('background', 'hsl(' + hue + ', 45%, 42%)');
        ic.textContent = (seed[0] || '#').toUpperCase();
        if (it.entry) paintIcon(ic, it.entry, 20);
        const lbl = document.createElement('span');
        lbl.textContent = it.label;
        styleEl(lbl, { 'font-weight': '600', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' });
        row.appendChild(ic);
        row.appendChild(lbl);
        if (it.sub) {
          const sub = document.createElement('span');
          sub.textContent = it.sub;
          styleEl(sub, { color: C.sub, 'font-size': '11px', 'margin-left': 'auto', 'padding-left': '8px', 'white-space': 'nowrap' });
          row.appendChild(sub);
        }
        if (it.selected) {
          const tick = document.createElement('span');
          tick.textContent = '✓';
          styleEl(tick, { color: C.accent, 'font-weight': '800', 'margin-left': it.sub ? '6px' : 'auto' });
          row.appendChild(tick);
        }
        row.addEventListener('mouseenter', () => row.style.setProperty('background', C.hover));
        row.addEventListener('mouseleave', () => row.style.setProperty('background', 'transparent'));
        row.addEventListener('click', ev => { ev.stopPropagation(); closePop(); onPick(it); });
        p.appendChild(row);
      });
      document.documentElement.appendChild(p);
      const r = anchor.getBoundingClientRect();
      const pw = p.getBoundingClientRect();
      let x = Math.min(Math.max(8, r.left), innerWidth - pw.width - 8);
      let y = r.bottom + 6;
      if (y + pw.height > innerHeight - 8) y = Math.max(8, r.top - pw.height - 6);
      p.style.setProperty('left', x + 'px');
      p.style.setProperty('top', y + 'px');
      pop = p;
      pop.__xdrAnchor = anchor;
    }
    document.addEventListener('mousedown', e => {
      if (pop && !(e.target && pop.contains(e.target))) {
        const wasAnchor = !!(pop.__xdrAnchor && pop.__xdrAnchor.contains(e.target));
        closePop();
        if (wasAnchor) popSuppress = Date.now() + 250;
      }
    }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); }, true);
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
    window.addEventListener('scroll', closePop, true);

    // ---- send bar under every post: [icon] server ▾  channel ▾  @  Send ----
    function buildBar(article) {
      const dark = xTheme() === 'dark';
      const C = dark
        ? { text: '#e7e9ea', sub: '#71767b', line: '#2f3336', hover: 'rgba(29,155,240,.1)', accent: '#1d9bf0' }
        : { text: '#0f1419', sub: '#536471', line: '#eff3f4', hover: 'rgba(29,155,240,.1)', accent: '#1d9bf0' };

      const bar = document.createElement('div');
      styleEl(bar, {
        display: 'flex', 'align-items': 'center', 'flex-wrap': 'wrap', gap: '6px',
        'margin-top': '6px', padding: '6px 4px 2px', 'border-top': '1px solid ' + C.line,
        font: '13px system-ui, -apple-system, "Segoe UI", sans-serif', color: C.sub,
        cursor: 'default'
      });
      bar.setAttribute('data-xdr-bar', '1');
      // keep X from treating bar interactions as post clicks
      ['mousedown', 'click', 'mouseup', 'dblclick', 'auxclick'].forEach(evt =>
        bar.addEventListener(evt, e => e.stopPropagation()));

      const hist = history(); // build-time snapshot only used for initial sel
      const target = getTarget();

      const servers = [];
      const seenG = new Set();
      for (const hh of hist) {
        const g = hh.guild || 'other';
        if (seenG.has(g)) continue;
        seenG.add(g);
        servers.push({ g, label: hh.gname || (g === '@me' ? 'Direct Messages' : g === 'other' ? 'Other' : 'Server …' + String(g).slice(-4)) });
      }

      const chip = document.createElement('div');
      styleEl(chip, { width: '18px', height: '18px', 'border-radius': '50%', overflow: 'hidden',
        display: 'flex', 'align-items': 'center', 'justify-content': 'center',
        'font-size': '10px', 'font-weight': '700', color: '#fff', flex: '0 0 18px' });

      function refreshChip(entry) {
        if (!entry) {
          chip.style.setProperty('background', 'hsl(220, 45%, 42%)');
          chip.textContent = '➤';
          return;
        }
        const seed = entry.gname || entry.name || entry.id || '?';
        const hue = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
        chip.style.setProperty('background', 'hsl(' + hue + ', 45%, 42%)');
        chip.textContent = (seed[0] || '#').toUpperCase();
        paintIcon(chip, entry, 18);
      }

      const chipStyle = { display: 'flex', 'align-items': 'center', gap: '6px',
        padding: '4px 12px', 'border-radius': '9999px', cursor: 'pointer',
        border: '1px solid ' + C.line, color: C.text, 'font-weight': '700',
        'font-size': '13px', 'max-width': '180px', background: 'transparent' };
      function makeChip(getLabel, onOpen) {
        const b = document.createElement('div');
        b.setAttribute('role', 'button');
        styleEl(b, chipStyle);
        const lbl = document.createElement('span');
        lbl.textContent = getLabel();
        styleEl(lbl, { overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' });
        const car = document.createElement('span');
        car.textContent = '▾';
        styleEl(car, { color: C.sub, 'font-size': '10px' });
        b.appendChild(lbl); b.appendChild(car);
        b.addEventListener('mouseenter', () => b.style.setProperty('background', C.hover));
        b.addEventListener('mouseleave', () => b.style.setProperty('background', 'transparent'));
        b.addEventListener('click', ev => { ev.stopPropagation(); onOpen(b, lbl); });
        b.refresh = () => { lbl.textContent = getLabel(); };
        return b;
      }

      // selection state — SHARED across every bar (module-level), so changing
      // the target on one post's bar updates them all
      if (!runXSide.sel) {
        const t0 = getTarget();
        const h0 = history();
        const s0 = (t0 && t0.guild && h0.some(hh => (hh.guild || 'other') === t0.guild)) ? t0.guild : '__current';
        runXSide.sel = {
          server: s0,
          channel: s0 === '__current' ? null
            : (h0.find(hh => hh.id === t0.id && (hh.guild || 'other') === s0) || h0.find(hh => (hh.guild || 'other') === s0) || null)
        };
      }
      const sel = runXSide.sel;
      if (!runXSide.bars) runXSide.bars = new Set();
      runXSide.bars.add(bar);

      function channelsOf(g) { return history().filter(hh => (hh.guild || 'other') === g); } // LIVE read
      function chanLabel(hh) {
        if (!hh) return 'open channel';
        return (hh.name && hh.name[0] === '#') ? hh.name
          : ((hh.guild === '@me') ? (hh.name || hh.id) : '#' + (hh.name || hh.id));
      }
      function srvLabel(g) {
        if (g === '__current') return 'Open tab';
        const s = servers.find(x => x.g === g);
        return s ? s.label : 'Server';
      }
      function currentEntry() {
        return sel.server === '__current' ? null : sel.channel;
      }
      function persistTarget() {
        const t = currentEntry();
        if (t) setTarget(t); else gset(TARGET_KEY, 'null');
      }
      function syncAllBars() {
        for (const b of runXSide.bars) {
          if (!b.isConnected) { runXSide.bars.delete(b); continue; }
          if (b.sync) b.sync();
        }
      }
      // (history listener is module-level — one registration, not one per bar)


      const srvChip = makeChip(
        () => srvLabel(sel.server),
        (btn) => {
          const items = [{ key: '__current', label: 'Open tab', sub: 'current channel', selected: sel.server === '__current' }];
          servers.forEach(s => items.push({
            key: s.g, label: s.label, sub: channelsOf(s.g).length + ' ch',
            selected: sel.server === s.g,
            iconSeed: s.label, entry: channelsOf(s.g)[0]
          }));
          openPop(btn, items, it => {
            sel.server = it.key;
            sel.channel = it.key === '__current' ? null : (channelsOf(it.key)[0] || null);
            persistTarget();
            syncAllBars();
          });
        });
      const chChip = makeChip(
        () => sel.server === '__current' ? 'open channel' : chanLabel(sel.channel),
        (btn) => {
          if (sel.server === '__current') {
            openPop(btn, [{ key: 'current', label: 'currently open channel', selected: true }], () => {});
            return;
          }
          const items = channelsOf(sel.server).map(hh => ({
            key: hh.id, label: chanLabel(hh), selected: sel.channel && sel.channel.id === hh.id,
            iconSeed: hh.gname || hh.id, entry: hh
          }));
          openPop(btn, items, it => {
            sel.channel = channelsOf(sel.server).find(hh => hh.id === it.key) || null;
            persistTarget();
            syncAllBars();
          });
        });
      bar.sync = () => {
        // live re-read: servers rebuild so backfilled names/icons appear
        const h = history();
        servers.length = 0; seenG.clear();
        for (const hh of h) {
          const g = hh.guild || 'other';
          if (seenG.has(g)) continue;
          seenG.add(g);
          servers.push({ g, label: hh.gname || (g === '@me' ? 'Direct Messages' : g === 'other' ? 'Other' : 'Server …' + String(g).slice(-4)) });
        }
        if (sel.channel) sel.channel = h.find(hh => hh.id === sel.channel.id) || sel.channel;
        srvChip.refresh();
        chChip.refresh();
        refreshChip(sel.server === '__current' ? null : channelsOf(sel.server)[0]);
      };
      bar.sync();



      // transport mode chip: Tab (GM storage → browser tab) / App (broker → Vencord)
      const modeBtn = document.createElement('div');
      modeBtn.setAttribute('role', 'button');
      modeBtn.setAttribute('data-xdr-mode', '1');
      function refreshModeBtn() {
        const app = getMode() === 'app';
        const SVG_TAB = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
        const SVG_APP = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
        modeBtn.innerHTML = app ? SVG_APP : SVG_TAB;
        modeBtn.title = app
          ? 'Send via Discord desktop app (Vencord plugin) — click to use browser tab instead'
          : 'Send via Discord browser tab — click to use desktop app (Vencord) instead';
        styleEl(modeBtn, { display: 'flex', 'align-items': 'center', 'justify-content': 'center',
          'min-width': '26px', height: '26px', 'border-radius': '9999px', cursor: 'pointer',
          border: '1px solid ' + C.line, padding: '0 6px',
          color: app ? (appAlive === false ? C.sub : C.accent) : C.sub });
      }
      refreshModeBtn();
      modeBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        const next = getMode() === 'app' ? 'tab' : 'app';
        if (next === 'app') {
          brokerHealth(ok => {
            gset(MODE_KEY, ok ? 'app' : 'tab');
            toast(ok ? 'App mode ON — sends go through the desktop app' : 'Broker unreachable — staying in Tab mode (start xdr-broker first)', ok ? 'ok' : 'err');
            document.querySelectorAll('[data-xdr-mode]').forEach(b => { if (b.refresh) b.refresh(); });
          });
        } else {
          gset(MODE_KEY, 'tab');
          toast('Tab mode ON — sends go through the Discord browser tab');
          document.querySelectorAll('[data-xdr-mode]').forEach(b => { if (b.refresh) b.refresh(); });
        }
      });
      modeBtn.refresh = refreshModeBtn;

      const pingBtn = document.createElement('div');
      pingBtn.setAttribute('role', 'button');
      function refreshPingBtn() {
        const d = getPingData();
        const count = (d.presets[d.active] || []).length;
        const on = d.on !== false;
        pingBtn.textContent = '';
        const at = document.createElement('span');
        at.textContent = '@';
        pingBtn.appendChild(at);
        if (count > 0) {
          const badge = document.createElement('span');
          badge.textContent = String(count);
          styleEl(badge, { 'font-size': '9px', 'font-weight': '800', 'min-width': '14px',
            height: '14px', 'border-radius': '7px', display: 'inline-flex',
            'align-items': 'center', 'justify-content': 'center', padding: '0 3px',
            background: on ? C.accent : C.sub, color: '#fff', 'margin-left': '2px' });
          pingBtn.appendChild(badge);
        }
        pingBtn.title = on ? 'Ping: ' + d.active + ' (' + count + ') — click to manage, right-click toggle' : 'Ping OFF — right-click to toggle';
        styleEl(pingBtn, { display: 'flex', 'align-items': 'center', 'justify-content': 'center',
          gap: '2px', 'min-width': '26px', height: '26px', 'border-radius': '9999px', cursor: 'pointer',
          'font-weight': '800', 'font-size': '13px', border: '1px solid ' + C.line,
          padding: '0 6px', color: on ? C.accent : C.sub });
      }
      refreshPingBtn();

      pingBtn.addEventListener('contextmenu', ev => {
        ev.preventDefault(); ev.stopPropagation();
        const d = getPingData();
        d.on = !(d.on !== false);
        setPingData(d);
        refreshPingBtn();
        toast(d.on ? 'Ping ON' : 'Ping OFF');
      });

      pingBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        if (Date.now() < popSuppress) return;
        closePop();
        const dark = xTheme() === 'dark';
        const Cp = dark
          ? { text: '#e7e9ea', sub: '#71767b', line: '#2f3336', hover: 'rgba(29,155,240,.1)', accent: '#1d9bf0', bg: '#1e2126' }
          : { text: '#0f1419', sub: '#536471', line: '#eff3f4', hover: 'rgba(29,155,240,.1)', accent: '#1d9bf0', bg: '#fff' };

        const d = getPingData();
        let viewPreset = d.active;

        const p = document.createElement('div');
        styleEl(p, {
          position: 'fixed', 'z-index': '2147483646', 'min-width': '240px', 'max-width': '320px',
          padding: '4px', background: Cp.bg,
          border: '1px solid ' + Cp.line, 'border-radius': '14px',
          'box-shadow': '0 8px 28px rgba(0,0,0,' + (dark ? '.6' : '.25') + ')',
          font: '13px system-ui, -apple-system, "Segoe UI", sans-serif'
        });

        const header = document.createElement('div');
        styleEl(header, { padding: '8px 10px 4px', 'font-weight': '800', 'font-size': '13px', color: Cp.text });
        header.textContent = 'Ping Presets';
        p.appendChild(header);

        const tabBar = document.createElement('div');
        styleEl(tabBar, { display: 'flex', gap: '4px', padding: '4px 10px', 'flex-wrap': 'wrap' });
        p.appendChild(tabBar);

        const listContainer = document.createElement('div');
        p.appendChild(listContainer);

        const addRow = document.createElement('div');
        styleEl(addRow, { display: 'flex', gap: '4px', padding: '6px 10px', 'border-top': '1px solid ' + Cp.line, 'margin-top': '4px' });
        const inp = document.createElement('input');
        inp.placeholder = 'Paste user ID';
        inp.setAttribute('type', 'text');
        inp.setAttribute('data-xdr-input', '1');
        styleEl(inp, { flex: '1', padding: '4px 8px', 'border-radius': '8px', border: '1px solid ' + Cp.line,
          background: 'transparent', color: Cp.text, font: '13px system-ui, sans-serif', outline: 'none', 'min-width': '0' });
        const lblInp = document.createElement('input');
        lblInp.placeholder = 'Label';
        lblInp.setAttribute('type', 'text');
        lblInp.setAttribute('data-xdr-input', '1');
        styleEl(lblInp, { width: '56px', padding: '4px 8px', 'border-radius': '8px', border: '1px solid ' + Cp.line,
          background: 'transparent', color: Cp.text, font: '13px system-ui, sans-serif', outline: 'none' });
        const addBtnEl = document.createElement('div');
        addBtnEl.textContent = '＋';
        addBtnEl.setAttribute('role', 'button');
        styleEl(addBtnEl, { display: 'flex', 'align-items': 'center', 'justify-content': 'center',
          width: '28px', height: '28px', 'border-radius': '8px', cursor: 'pointer',
          'font-weight': '800', 'font-size': '16px', color: Cp.accent });
        addBtnEl.addEventListener('mouseenter', () => addBtnEl.style.setProperty('background', Cp.hover));
        addBtnEl.addEventListener('mouseleave', () => addBtnEl.style.setProperty('background', 'transparent'));

        function doAdd() {
          const raw = inp.value.trim();
          const ids = raw.split(/[\s,;]+/).filter(s => /^\d{17,20}$/.test(s));
          if (!ids.length) { toast('Paste one or more user IDs (17–20 digits)', 'err'); return; }
          let added = 0;
          ids.forEach(uid => { if (addPingUser(viewPreset, uid, ids.length === 1 ? lblInp.value : '')) added++; });
          if (added) {
            inp.value = ''; lblInp.value = '';
            renderAll();
            refreshPingBtn();
            toast('Added ' + added + ' user(s) to ' + viewPreset, 'ok');
          } else {
            toast('Already added or invalid', 'err');
          }
        }
        inp.__xdrEnter = doAdd;

        addBtnEl.addEventListener('click', e2 => { e2.stopPropagation(); doAdd(); });
        [inp, lblInp].forEach(el => {
          ['mousedown', 'click', 'mouseup'].forEach(evt =>
            el.addEventListener(evt, e2 => e2.stopPropagation()));
        });

        addRow.appendChild(inp);
        addRow.appendChild(lblInp);
        addRow.appendChild(addBtnEl);
        p.appendChild(addRow);

        const bottomRow = document.createElement('div');
        styleEl(bottomRow, { display: 'flex', gap: '6px', padding: '6px 10px', 'border-top': '1px solid ' + Cp.line, 'margin-top': '2px', 'align-items': 'center' });

        const newPresetBtn = document.createElement('div');
        newPresetBtn.setAttribute('role', 'button');
        newPresetBtn.textContent = '＋ New preset';
        styleEl(newPresetBtn, { 'font-weight': '600', 'font-size': '12px', color: Cp.accent, cursor: 'pointer', padding: '4px 8px', 'border-radius': '6px' });
        newPresetBtn.addEventListener('mouseenter', () => newPresetBtn.style.setProperty('background', Cp.hover));
        newPresetBtn.addEventListener('mouseleave', () => newPresetBtn.style.setProperty('background', 'transparent'));

        const nameInp = document.createElement('input');
        nameInp.placeholder = 'Preset name';
        nameInp.setAttribute('type', 'text');
        nameInp.setAttribute('data-xdr-input', '1');
        styleEl(nameInp, { flex: '1', padding: '4px 8px', 'border-radius': '8px', border: '1px solid ' + Cp.line,
          background: 'transparent', color: Cp.text, font: '13px system-ui, sans-serif', outline: 'none', 'min-width': '0', display: 'none' });

        const okBtn = document.createElement('div');
        okBtn.setAttribute('role', 'button');
        okBtn.textContent = '✓';
        styleEl(okBtn, { display: 'none', 'align-items': 'center', 'justify-content': 'center', width: '26px', height: '26px',
          'border-radius': '6px', cursor: 'pointer', 'font-weight': '800', color: '#2ecc71' });
        okBtn.addEventListener('mouseenter', () => okBtn.style.setProperty('background', Cp.hover));
        okBtn.addEventListener('mouseleave', () => okBtn.style.setProperty('background', 'transparent'));

        const cancelBtn = document.createElement('div');
        cancelBtn.setAttribute('role', 'button');
        cancelBtn.textContent = '✕';
        styleEl(cancelBtn, { display: 'none', 'align-items': 'center', 'justify-content': 'center', width: '26px', height: '26px',
          'border-radius': '6px', cursor: 'pointer', 'font-weight': '800', color: Cp.sub });
        cancelBtn.addEventListener('mouseenter', () => cancelBtn.style.setProperty('background', Cp.hover));
        cancelBtn.addEventListener('mouseleave', () => cancelBtn.style.setProperty('background', 'transparent'));

        function setCreateMode(on) {
          newPresetBtn.style.setProperty('display', on ? 'none' : 'block');
          nameInp.style.setProperty('display', on ? 'block' : 'none');
          okBtn.style.setProperty('display', on ? 'flex' : 'none');
          cancelBtn.style.setProperty('display', on ? 'flex' : 'none');
          if (on) setTimeout(() => nameInp.focus(), 40);
        }
        function doCreate() {
          const name = nameInp.value.trim();
          if (!name) { toast('Preset name required', 'err'); return; }
          const d2 = getPingData();
          if (d2.presets[name]) { toast('Preset already exists', 'err'); return; }
          d2.presets[name] = [];
          d2.active = name;
          setPingData(d2);
          viewPreset = name;
          nameInp.value = '';
          setCreateMode(false);
          renderAll();
          refreshPingBtn();
          toast('Preset "' + name + '" created', 'ok');
        }
        nameInp.__xdrEnter = doCreate;
        newPresetBtn.addEventListener('click', e2 => { e2.stopPropagation(); setCreateMode(true); });
        okBtn.addEventListener('click', e2 => { e2.stopPropagation(); doCreate(); });
        cancelBtn.addEventListener('click', e2 => { e2.stopPropagation(); setCreateMode(false); });
        ['mousedown', 'click', 'mouseup'].forEach(evt =>
          nameInp.addEventListener(evt, e2 => e2.stopPropagation()));

        const toggleLbl = document.createElement('span');
        const td = getPingData();
        toggleLbl.textContent = (td.on !== false) ? '● ON' : '○ OFF';
        styleEl(toggleLbl, { 'font-weight': '700', 'font-size': '12px', color: (td.on !== false) ? '#2ecc71' : Cp.sub, cursor: 'pointer', 'margin-left': 'auto', padding: '4px 8px', 'border-radius': '6px' });
        toggleLbl.addEventListener('mouseenter', () => toggleLbl.style.setProperty('background', Cp.hover));
        toggleLbl.addEventListener('mouseleave', () => toggleLbl.style.setProperty('background', 'transparent'));
        toggleLbl.addEventListener('click', e2 => {
          e2.stopPropagation();
          const d2 = getPingData();
          d2.on = !(d2.on !== false);
          setPingData(d2);
          toggleLbl.textContent = d2.on ? '● ON' : '○ OFF';
          toggleLbl.style.setProperty('color', d2.on ? '#2ecc71' : Cp.sub);
          refreshPingBtn();
        });

        bottomRow.appendChild(newPresetBtn);
        bottomRow.appendChild(nameInp);
        bottomRow.appendChild(okBtn);
        bottomRow.appendChild(cancelBtn);
        bottomRow.appendChild(toggleLbl);
        p.appendChild(bottomRow);

        function renderAll() {
          const d2 = getPingData();
          tabBar.textContent = '';
          Object.keys(d2.presets).forEach(name => {
            const tab = document.createElement('div');
            tab.textContent = name;
            const isActive = name === d2.active;
            const isViewing = name === viewPreset;
            styleEl(tab, {
              padding: '3px 10px', 'border-radius': '9999px', cursor: 'pointer',
              'font-weight': '700', 'font-size': '12px',
              background: isViewing ? (isActive ? Cp.accent : Cp.line) : 'transparent',
              color: isViewing ? (isActive ? '#fff' : Cp.text) : (isActive ? Cp.accent : Cp.sub),
              border: '1px solid ' + (isActive ? Cp.accent : Cp.line)
            });
            tab.addEventListener('click', e2 => {
              e2.stopPropagation();
              const d3 = getPingData();
              d3.active = name;
              setPingData(d3);
              viewPreset = name;
              renderAll();
              refreshPingBtn();
            });
            tab.addEventListener('contextmenu', e2 => {
              e2.preventDefault(); e2.stopPropagation();
              if (Object.keys(getPingData().presets).length <= 1) { toast('Cannot delete the last preset', 'err'); return; }
              if (tab.__xdrArm) {
                delete tab.__xdrArm;
                const d3 = getPingData();
                delete d3.presets[name];
                if (d3.active === name) d3.active = Object.keys(d3.presets)[0];
                setPingData(d3);
                viewPreset = d3.active;
                renderAll();
                refreshPingBtn();
                toast('Deleted preset "' + name + '"');
              } else {
                tab.__xdrArm = true;
                tab.style.setProperty('color', '#ff5c7a');
                tab.style.setProperty('border-color', '#ff5c7a');
                tab.title = 'Right-click again to delete "' + name + '"';
                setTimeout(() => {
                  if (tab.__xdrArm) { delete tab.__xdrArm; tab.title = ''; renderAll(); }
                }, 4000);
              }
            });
            tabBar.appendChild(tab);
          });

          listContainer.textContent = '';
          const users = d2.presets[viewPreset] || [];
          if (!users.length) {
            const empty = document.createElement('div');
            empty.textContent = 'No users in this preset';
            styleEl(empty, { padding: '8px 10px', color: Cp.sub, 'font-size': '12px', 'font-style': 'italic' });
            listContainer.appendChild(empty);
          }
          users.forEach(u => {
            const row = document.createElement('div');
            styleEl(row, { display: 'flex', 'align-items': 'center', gap: '8px',
              padding: '5px 10px', 'border-radius': '8px', color: Cp.text });
            const lbl = document.createElement('span');
            lbl.textContent = u.label || u.id;
            styleEl(lbl, { 'font-weight': '600', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' });
            const idSpan = document.createElement('span');
            idSpan.textContent = u.id;
            styleEl(idSpan, { color: Cp.sub, 'font-size': '11px', 'white-space': 'nowrap' });
            const rm = document.createElement('span');
            rm.textContent = '✕';
            styleEl(rm, { color: Cp.sub, cursor: 'pointer', 'font-weight': '800', 'font-size': '12px', padding: '2px 4px', 'border-radius': '4px' });
            rm.addEventListener('mouseenter', () => rm.style.setProperty('color', '#ff5c7a'));
            rm.addEventListener('mouseleave', () => rm.style.setProperty('color', Cp.sub));
            rm.addEventListener('click', rmEv => {
              rmEv.stopPropagation();
              removePingUser(viewPreset, u.id);
              renderAll();
              refreshPingBtn();
            });
            row.appendChild(lbl);
            row.appendChild(idSpan);
            row.appendChild(rm);
            listContainer.appendChild(row);
          });
        }
        renderAll();

        document.documentElement.appendChild(p);
        const r = pingBtn.getBoundingClientRect();
        const pw = p.getBoundingClientRect();
        let px = Math.min(Math.max(8, r.left), innerWidth - pw.width - 8);
        let py = r.bottom + 6;
        if (py + pw.height > innerHeight - 8) py = Math.max(8, r.top - pw.height - 6);
        p.style.setProperty('left', px + 'px');
        p.style.setProperty('top', py + 'px');
        pop = p;
        pop.__xdrAnchor = pingBtn;
        setTimeout(() => inp.focus(), 50);
      });

      const sendBtn = document.createElement('div');
      sendBtn.setAttribute('role', 'button');
      sendBtn.innerHTML = SEND_SVG + '<span>Send</span>';
      styleEl(sendBtn, { display: 'flex', 'align-items': 'center', gap: '6px',
        padding: '4px 14px', 'border-radius': '9999px', cursor: 'pointer',
        'font-weight': '700', color: C.accent, 'font-size': '13px', 'margin-left': 'auto' });
      sendBtn.addEventListener('mouseenter', () => sendBtn.style.setProperty('background', C.hover));
      sendBtn.addEventListener('mouseleave', () => sendBtn.style.setProperty('background', 'transparent'));
      sendBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        relay(articleUrl(article) || lastTweetUrl, currentEntry(), isPingOn());
      });

      bar.appendChild(chip);
      bar.appendChild(srvChip);
      bar.appendChild(chChip);
      bar.appendChild(modeBtn);
      bar.appendChild(pingBtn);
      bar.appendChild(sendBtn);
      bar.refreshPing = refreshPingBtn;
      bar.setSending = on => { sendBtn.style.setProperty('opacity', on ? '.45' : '1'); sendBtn.style.setProperty('pointer-events', on ? 'none' : 'auto'); };
      bar.addEventListener('contextmenu', ev => {
        if (ev.target !== bar) return;
        if (gget('xdr.pillHidden', '') === '1') { gset('xdr.pillHidden', '0'); makePill(); toast('Quick-send pill restored'); }
      });
      return bar;
    }

    const hoverCss = document.createElement('style');
    hoverCss.textContent =
      'article[data-xdr-done]:not(:hover) [data-xdr-bar]{display:none!important}' +
      'article[data-xdr-main] [data-xdr-bar]{display:flex!important}' +
      '#xdrPill [data-xdr-pillx]{opacity:0;transition:opacity .12s ease}#xdrPill:hover [data-xdr-pillx]{opacity:1}';
    function injectBars() {
      if (!hoverCss.isConnected && document.documentElement) document.documentElement.appendChild(hoverCss);
      const statusPath = (location.pathname.match(/^\/[^/]+\/status\/\d+/) || [])[0];
      let arts = document.querySelectorAll('article[data-testid="tweet"]');
      if (!arts.length) arts = document.querySelectorAll('article'); // logged-out layout fallback
      for (const art of arts) {
        const u = articleUrl(art);
        if (u && statusPath) {
          try { if (new URL(u, location.origin).pathname.startsWith(statusPath)) art.setAttribute('data-xdr-main', '1'); else art.removeAttribute('data-xdr-main'); } catch (e) {}
        } else if (art.getAttribute('data-xdr-main')) art.removeAttribute('data-xdr-main');
        if (art.getAttribute('data-xdr-done')) continue;
        if (!u) continue;
        const replyEl = art.querySelector('[data-testid="reply"]') || art.querySelector('[role="group"]');
        // climb to the first node with 3+ element children — that's the full
        // action ROW ([data-testid=reply] is just the reply button; its parent
        // is only the icon+count group, and inserting there wrecks the layout)
        let actionRow = null;
        let el = replyEl;
        while (el && el !== art) {
          if (el.children.length >= 3) { actionRow = el; break; }
          el = el.parentElement;
        }
        if (!actionRow) actionRow = art.lastElementChild;
        const col = actionRow.parentElement || art;
        if (col.querySelector('[data-xdr-bar]')) continue;
        art.setAttribute('data-xdr-done', '1');
        col.insertBefore(buildBar(art), actionRow.parentElement === col ? actionRow.nextSibling : null);
      }
    }

    // floating quick-send: posts the last hovered post to the selected target
    function makePill() {
      if (gget('xdr.pillHidden', '') === '1') return;
      const dark = xTheme() === 'dark';
      const p = document.createElement('div');
      p.id = 'xdrPill';
      styleEl(p, { position: 'fixed', right: '20px', bottom: '20px', 'z-index': '2147483647',
        display: 'flex', 'align-items': 'center', gap: '8px', padding: '7px 8px 7px 14px', 'border-radius': '999px', cursor: 'pointer',
        font: '600 13px system-ui, sans-serif',
        color: dark ? '#e7e9ea' : '#0f1419',
        background: dark ? '#1e2126' : '#ffffff', border: '1px solid ' + (dark ? '#2f3336' : '#eff3f4'),
        'box-shadow': '0 6px 20px rgba(0,0,0,' + (dark ? '.4' : '.12') + ')', 'user-select': 'none' });
      const ic = document.createElement('span');
      ic.innerHTML = SEND_SVG;
      styleEl(ic, { display: 'flex', 'align-items': 'center', color: '#1d9bf0' });
      const lbl = document.createElement('span');
      lbl.textContent = 'Discord';
      const x = document.createElement('span');
      x.setAttribute('data-xdr-pillx', '1');
      x.textContent = '✕';
      styleEl(x, { display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'min-width': '18px', height: '18px',
        'border-radius': '50%', cursor: 'pointer', 'font-size': '11px', 'font-weight': '800',
        color: dark ? '#71767b' : '#536471' });
      x.addEventListener('click', ev => {
        ev.stopPropagation();
        gset('xdr.pillHidden', '1');
        p.remove();
        toast('Quick-send pill hidden — right-click a send bar to bring it back');
      });
      p.appendChild(ic);
      p.appendChild(lbl);
      p.appendChild(x);
      p.addEventListener('click', ev => { ev.stopPropagation(); relay(null, getTarget(), isPingOn()); });
      document.documentElement.appendChild(p);
    }

    setInterval(injectBars, 1500);
    function syncAllBarsModule() {
      for (const b of (runXSide.bars || new Set())) {
        if (!b.isConnected) { runXSide.bars.delete(b); continue; }
        if (b.sync) b.sync();
      }
    }
    GM_addValueChangeListener(HIST_KEY, (name, oldV, newV, remote) => { if (remote) syncAllBarsModule(); });
    GM_addValueChangeListener(PING_PRESET_KEY, (name, oldV, newV, remote) => {
      if (!remote) return;
      for (const b of (runXSide.bars || new Set())) { if (b.refreshPing) b.refreshPing(); }
    });
    setInterval(sweepStale, 60000);
    sweepStale();
    if (document.documentElement) makePill(); else setTimeout(makePill, 300);
    W.addEventListener('keydown', e => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyD') {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault(); e.stopPropagation();
        relay(lastTweetUrl, getTarget(), isPingOn());
      }
    }, true);
    console.debug('[xdr] X side active v1.8.0');
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
    setInterval(() => {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      const m = location.pathname.match(/^\/channels\/(\d+|@me)\/(\d+)/);
      if (!m) return;
      const ch = m[2], guild = m[1];
      setTimeout(() => {           // let the composer label + guild rail settle
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
      box.focus();
      try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch (e) {}
      if (!await pollUntil(() => (box.textContent || '').trim() === '', 800, 80)) {
        console.debug('[xdr] composer not clearable — not pasting');
        return false;
      }
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      } catch (e) { return false; }
      if (!await pollUntil(() => (box.textContent || '').includes(text.slice(0, 24)), 2000, 100)) {
        console.debug('[xdr] paste did not land');
        return false;
      }
      box.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
      }));
      if (await pollUntil(() => (box.textContent || '').trim() === '', 1500, 100)) return true;
      const btn = Array.from(document.querySelectorAll('[role="button"][aria-label], button[aria-label]'))
        .find(b => /^send$/i.test(b.getAttribute('aria-label') || ''));
      if (btn) btn.click();
      const flushed = await pollUntil(() => (box.textContent || '').trim() === '', 1500, 100);
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

    // SPA route change without reload (Discord's router listens to popstate)
    async function spaNavigate(path) {
      try {
        window.history.pushState({}, '', path);
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      } catch (e) {}
      await sleep(500);
      return location.pathname === path;
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
          // no guild recorded for this channel — internals are the only option
          return clientSend(channelId, content);
        }
        const okNav = await spaNavigate('/channels/' + guild + '/' + channelId);
        await sleep(700);
        const box = composer();
        const label = (box && box.getAttribute('aria-label')) || '';
        const want = String(chName || '').replace(/^#/, '').trim();
        const verified = okNav && box && (!want || label.toLowerCase().includes(want.toLowerCase()));
        if (!verified) {
          console.debug('[xdr] nav-verify failed (label="' + label + '" want="' + want + '") — not pasting');
          await spaNavigate(back);
          return clientSend(channelId, content);  // best-effort fallback
        }
        const sent = await domSend(content);
        await spaNavigate(back);
        return sent ? 'dom-nav' : 'DOMFAIL';
      }
      return (await domSend(content)) ? 'dom' : 'DOMFAIL';
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
    GM_addValueChangeListener(REQ_KEY, (name, oldV, newV, remote) => {
      if (!remote || !isLeader) return;
      let req; try { req = JSON.parse(newV); } catch (e) { return; }
      if (!req || !req.id || req.id === lastReqId) return;
      if (gget(lockKey(req.id), '')) return;
      gset(lockKey(req.id), ME + ':' + Date.now());
      lastReqId = req.id;
      handleRelay(req);
    });

    async function handleRelay(req) {
      const ack = o => gset(ackKey(req.id), JSON.stringify(Object.assign({ ts: Date.now() }, o)));
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
          if (via && via !== 'DOMFAIL') {
            ack({ ok: true, ch, chName: req.chName || channelLabel(), via });
            console.debug('[xdr] sent via ' + via + ' to ' + ch);
          } else if (via === 'DOMFAIL') {
            ack({ ok: false, ch, err: 'composer send failed — the link may still be sitting in the composer; press Enter manually or clear it' });
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

    console.debug('[xdr] Discord side active v1.8.0');
  }

  // ---------------- dispatch ----------------
  const host = location.hostname;
  if (host === 'discord.com' || host === 'ptb.discord.com' || host === 'canary.discord.com') runDiscordSide();
  else runXSide();
})();
