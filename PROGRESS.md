# XDR v1.10 — live progress (updated by agent, newest last)

- [x] Research whole stack (transport, discord tab, x feed, security, tests)
- [x] Commit v1.9.x batch (`539addf`)
- [x] Rebuild + deploy plugin, restart broker (verified live)
- [x] Userscript P0 batch (queue, lock, delKey, draft guard, history token, heal)
- [x] Broker security + 409 (auth, CORS echo, Host/Origin, TTL env)
- [x] Plugin token header + setup/rebuild token provisioning
- [x] Broker auth re-test (401s, 409, claim-once, host guard — all green)
- [x] Test broker cleaned up, main broker (8765) healthy
- [x] Plugin `tsc --noEmit` re-run (clean, 0 errors)
- [x] Test suite: transform / protocol / broker / plugin / check / run (GATE GREEN)
- [x] Docs (README + AGENTS) touch-up
- [x] Final gates + commit (`bb6845d`, v1.10.0)

Status: DONE — v1.10.0 live everywhere. Rebuild deployed, broker on token mode, Discord relaunched.
