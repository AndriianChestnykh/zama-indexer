// Database schema for the ConfidentialUSD indexer (see implementation-plan.md §"Database schema").
//
// Design rule: cleartext for any FHE handle lives in exactly ONE place — the `fheHandle` table.
// Both transfer-amount handles and balance handles are rows here; `transaction` and `balance` only
// reference a handle. So when an ACL grant lets us decrypt a previously-`unauthorized` handle later,
// we patch a single `fheHandle` row and every reader (balances + history) sees the cleartext — no
// second copy to keep in sync.
import { index, onchainTable } from "ponder";

/**
 * Every euint64 handle the indexer has seen, and its cleartext once we can decrypt it.
 * status:
 *  - `pending`      — not yet attempted, or a transient decrypt failure to retry
 *  - `decrypted`    — we hold ACL rights (party to the transfer, own balance, or delegation)
 *  - `unauthorized` — we are NOT entitled to decrypt (kept, NOT dropped; retried on ACL grant)
 *  - `disclosed`    — value is public on-chain (UnwrapFinalized / AmountDisclosed), no rights needed
 */
export const fheHandle = onchainTable("fhe_handle", (t) => ({
  handle: t.hex().primaryKey(),
  contract: t.hex().notNull(),
  cleartext: t.bigint(), // null until known
  status: t.text().notNull(),
  lastTriedBlock: t.bigint(),
}));

/**
 * One row per token movement, classified into the three lifecycle types the wallet partner sees.
 *  - `shield`   — mint leg (ConfidentialTransfer from == 0x0); `from` is null
 *  - `transfer` — internal confidential transfer (both parties set)
 *  - `unshield` — burn → underlying ERC-20; keyed by `unwrapRequestId`, `to` is null, has `state`
 * `state` (unshield only): `requested` → balance already debited in ERC-7984 but ERC-20 not yet
 * delivered (the awkward in-between, surfaced at the API as `pending_finalization`) → `finalized`.
 */
export const transaction = onchainTable(
  "transaction",
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}` for shield/transfer, `unwrapRequestId` for unshield
    type: t.text().notNull(),
    from: t.hex(),
    to: t.hex(),
    amountHandle: t.hex().notNull(), // -> fheHandle.handle
    state: t.text(),
    unwrapRequestId: t.hex(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (t) => ({
    fromIdx: index().on(t.from),
    toIdx: index().on(t.to),
    blockIdx: index().on(t.blockNumber),
  }),
);

/** Latest known confidential balance handle per address (cleartext read via the fheHandle link). */
export const balance = onchainTable("balance", (t) => ({
  address: t.hex().primaryKey(),
  handle: t.hex().notNull(), // -> fheHandle.handle
  blockNumber: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
}));

/** ACL user-decryption delegations, so we know who granted the holder backfill rights. */
export const aclGrant = onchainTable(
  "acl_grant",
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}`
    delegator: t.hex().notNull(),
    delegate: t.hex().notNull(),
    contract: t.hex().notNull(),
    expiration: t.bigint().notNull(),
    revoked: t.boolean().notNull(),
    blockNumber: t.bigint().notNull(),
  }),
  (t) => ({ delegateIdx: index().on(t.delegate) }),
);

// --- Append-only raw event tables (audit trail; indexer-impl-task.md asks for one per event) ----------
export const confidentialTransferEvent = onchainTable("confidential_transfer_event", (t) => ({
  id: t.text().primaryKey(), // `${txHash}-${logIndex}`
  from: t.hex().notNull(),
  to: t.hex().notNull(),
  amountHandle: t.hex().notNull(),
  blockNumber: t.bigint().notNull(),
  txHash: t.hex().notNull(),
  logIndex: t.integer().notNull(),
}));

export const unwrapRequestedEvent = onchainTable("unwrap_requested_event", (t) => ({
  id: t.text().primaryKey(),
  receiver: t.hex().notNull(),
  unwrapRequestId: t.hex().notNull(),
  amountHandle: t.hex().notNull(),
  blockNumber: t.bigint().notNull(),
  txHash: t.hex().notNull(),
  logIndex: t.integer().notNull(),
}));

export const unwrapFinalizedEvent = onchainTable("unwrap_finalized_event", (t) => ({
  id: t.text().primaryKey(),
  receiver: t.hex().notNull(),
  unwrapRequestId: t.hex().notNull(),
  amountHandle: t.hex().notNull(),
  cleartextAmount: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  txHash: t.hex().notNull(),
  logIndex: t.integer().notNull(),
}));
