-- The hub currency for a new payment (payments#38), preloaded into the WASM handler of
-- `payments.payments.create` (ADR-0069 `reads`, same shape as cash_register#111): the sandbox
-- cannot read the database, and a payment the assistant or an API integration creates without a
-- currency must not turn into euros. ALWAYS one row — a hub that never set its currency reads
-- NULL, which the handler resolves like the runtime does (no currency → EUR). The runtime injects
-- :hub_id.
SELECT
  (SELECT h.value FROM hub_settings h WHERE h.hub_id = :hub_id AND h.key = 'currency') AS currency;
