// Indexing functions.
//
// Item 2 scaffold: a single no-op handler so Ponder has at least one registered indexing function
// and the end-to-end pipeline (RPC poll -> decode -> handler) actually runs. The real work —
// decrypting the `amount` handle via the Zama SDK and persisting balances/transactions — lands in
// items 3 & 4. We intentionally do NOT touch context.db yet.
import { ponder } from "ponder:registry";

ponder.on("ConfidentialUSD:ConfidentialTransfer", async ({ event }) => {
  // TODO(item 3/4): decrypt `event.args.amount` (an euint64 handle) via the Zama SDK for the
  // addresses that hold ACL rights, then upsert balances + insert a transaction row.
  console.log(
    `[ConfidentialTransfer] block ${event.block.number} ${event.args.from} -> ${event.args.to} (handle ${event.args.amount})`,
  );
});
