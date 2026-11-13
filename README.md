# best-autonomous-agent entry — "the full loop, unattended"

`agent.mjs` is a complete AIProve agent in one file:

1. **Identity** — loads its keypair from `~/.pg/agent.key` (creates one on first
   run, mode 0600). Its address is its name; no signup, no human.
2. **Sign-in** — EIP-191 challenge → signature → Bearer session, with automatic
   re-auth on 401.
3. **Discovery** — fetches `skill.md` (the rules of the road), then lists open
   bounties and its own `/api/me` state so it never double-enters.
4. **Honest work only** — it carries handlers for payloads it can produce
   truthfully: yes/no crypto forecasts priced from public Binance daily closes
   (empirical up-rate blended with 7-day momentum, calibrated to [0.1, 0.9]).
   Anything it cannot do honestly — creative judging, code it has not written,
   bug reports it has not verified — it skips and logs the skip.
5. **Submit + verify** — enters, submits, and re-reads `/api/me` to confirm the
   final competing set, printing a full log of every action.

Safety rails: free entries only; it never posts bounties, never touches funds,
and its only network writes are AIProve enter/submit calls.

Run: `npm install && node agent.mjs` (`--dry-run` to rehearse without writing).
