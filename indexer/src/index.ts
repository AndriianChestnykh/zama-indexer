// Indexing functions: decode token + ACL events, decrypt amounts we are entitled to, and persist
// balances + a cleartext-where-available transfer history. Ponder runs these for BOTH the historical
// backfill and live polling, so the same logic covers indexer-impl-task.md's "historical sync" and
// "real-time sync" workers; the only bespoke work is decryption, folded in here (see
// implementation-plan.md §"Key decision").
import { ponder } from "ponder:registry";
import { and, eq } from "ponder";
import {
  aclGrant,
  balance,
  confidentialTransferEvent,
  fheHandle,
  transaction,
  unwrapFinalizedEvent,
  unwrapRequestedEvent,
} from "ponder:schema";
import type { Address, Hex } from "viem";
import { ConfidentialUsdAbi } from "../abis/ConfidentialUsdAbi";
import { env } from "./config.js";
import { decryptor } from "./decryptor.js";
import { ZERO_ADDRESS, classifyTransfer, eventId } from "./logic.js";

// Ponder's per-event Context is a deep generic; the shared helpers below only touch `context.db`
// and `context.client`, so we accept it loosely. The event handlers themselves stay fully typed.
type Context = { db: any; client: any };

const TOKEN = env.confidentialUsdAddress.toLowerCase();
const HOLDER = env.holderAddress.toLowerCase();

/** Record a handle if unseen, then attempt to decrypt it (unless already known). */
async function ingestHandle(context: Context, handle: Hex, block: bigint): Promise<void> {
  await context.db
    .insert(fheHandle)
    .values({ handle, contract: env.confidentialUsdAddress, cleartext: null, status: "pending", lastTriedBlock: block })
    .onConflictDoNothing();

  const row = await context.db.find(fheHandle, { handle });
  if (row && (row.status === "decrypted" || row.status === "disclosed")) return;

  const outcome = await decryptor.tryDecrypt(handle);
  if (outcome.status === "decrypted") {
    await context.db.update(fheHandle, { handle }).set({ cleartext: outcome.value, status: "decrypted", lastTriedBlock: block });
  } else {
    await context.db.update(fheHandle, { handle }).set({ status: outcome.status, lastTriedBlock: block });
  }
}

/** Mark a handle's cleartext as publicly disclosed (UnwrapFinalized / AmountDisclosed). */
async function discloseHandle(context: Context, handle: Hex, value: bigint, block: bigint): Promise<void> {
  await context.db
    .insert(fheHandle)
    .values({ handle, contract: env.confidentialUsdAddress, cleartext: value, status: "disclosed", lastTriedBlock: block })
    .onConflictDoUpdate(() => ({ cleartext: value, status: "disclosed", lastTriedBlock: block }));
}

/** Re-read an address's on-chain confidential balance handle and decrypt it if we now can. */
async function refreshBalance(context: Context, address: Address, block: bigint, timestamp: bigint): Promise<void> {
  if (address.toLowerCase() === ZERO_ADDRESS) return;
  let handle: Hex;
  try {
    handle = (await context.client.readContract({
      abi: ConfidentialUsdAbi,
      address: env.confidentialUsdAddress,
      functionName: "confidentialBalanceOf",
      args: [address],
    })) as Hex;
  } catch (err) {
    console.warn(`[balance] read failed for ${address}: ${(err as Error).message}`);
    return;
  }
  await ingestHandle(context, handle, block);
  await context.db
    .insert(balance)
    .values({ address, handle, blockNumber: block, updatedAt: timestamp })
    .onConflictDoUpdate(() => ({ handle, blockNumber: block, updatedAt: timestamp }));
}

// --- ConfidentialTransfer: shield / transfer / unshield-leg --------------------------------------
ponder.on("ConfidentialUSD:ConfidentialTransfer", async ({ event, context }) => {
  const from = event.args.from as Address;
  const to = event.args.to as Address;
  const amount = event.args.amount as Hex;
  const id = eventId(event.transaction.hash, event.log.logIndex);
  const kind = classifyTransfer(from, to);

  await context.db
    .insert(confidentialTransferEvent)
    .values({ id, from, to, amountHandle: amount, blockNumber: event.block.number, txHash: event.transaction.hash, logIndex: event.log.logIndex })
    .onConflictDoNothing();

  await ingestHandle(context, amount, event.block.number);

  // The burn leg of an unshield (to == 0x0) is owned by the UnwrapRequested handler — don't double-count.
  if (kind !== "unshield") {
    await context.db
      .insert(transaction)
      .values({
        id,
        type: kind,
        from: kind === "shield" ? null : from,
        to,
        amountHandle: amount,
        state: null,
        unwrapRequestId: null,
        blockNumber: event.block.number,
        txHash: event.transaction.hash,
        logIndex: event.log.logIndex,
        timestamp: event.block.timestamp,
      })
      .onConflictDoNothing();
  }

  await refreshBalance(context, from, event.block.number, event.block.timestamp);
  await refreshBalance(context, to, event.block.number, event.block.timestamp);
});

// --- UnwrapRequested: opens an unshield (balance debited, ERC-20 not yet delivered) --------------
ponder.on("ConfidentialUSD:UnwrapRequested", async ({ event, context }) => {
  const receiver = event.args.receiver as Address;
  const unwrapRequestId = event.args.unwrapRequestId as Hex;
  const amount = event.args.amount as Hex;
  const id = eventId(event.transaction.hash, event.log.logIndex);

  await context.db
    .insert(unwrapRequestedEvent)
    .values({ id, receiver, unwrapRequestId, amountHandle: amount, blockNumber: event.block.number, txHash: event.transaction.hash, logIndex: event.log.logIndex })
    .onConflictDoNothing();

  await ingestHandle(context, amount, event.block.number);

  await context.db
    .insert(transaction)
    .values({
      id: unwrapRequestId,
      type: "unshield",
      from: receiver,
      to: null,
      amountHandle: amount,
      state: "requested",
      unwrapRequestId,
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      timestamp: event.block.timestamp,
    })
    .onConflictDoUpdate(() => ({ state: "requested", amountHandle: amount }));

  await refreshBalance(context, receiver, event.block.number, event.block.timestamp);
});

// --- UnwrapFinalized: closes an unshield; cleartext is public, no rights needed ------------------
ponder.on("ConfidentialUSD:UnwrapFinalized", async ({ event, context }) => {
  const receiver = event.args.receiver as Address;
  const unwrapRequestId = event.args.unwrapRequestId as Hex;
  const encryptedAmount = event.args.encryptedAmount as Hex;
  const cleartextAmount = event.args.cleartextAmount as bigint;
  const id = eventId(event.transaction.hash, event.log.logIndex);

  await context.db
    .insert(unwrapFinalizedEvent)
    .values({ id, receiver, unwrapRequestId, amountHandle: encryptedAmount, cleartextAmount, blockNumber: event.block.number, txHash: event.transaction.hash, logIndex: event.log.logIndex })
    .onConflictDoNothing();

  // The disclosed cleartext applies to whatever handle the unshield row points at (the request amount).
  const existing = await context.db.find(transaction, { id: unwrapRequestId });
  const targetHandle = (existing?.amountHandle ?? encryptedAmount) as Hex;
  await discloseHandle(context, targetHandle, cleartextAmount, event.block.number);
  if (targetHandle !== encryptedAmount) await discloseHandle(context, encryptedAmount, cleartextAmount, event.block.number);

  await context.db
    .insert(transaction)
    .values({
      id: unwrapRequestId,
      type: "unshield",
      from: receiver,
      to: null,
      amountHandle: targetHandle,
      state: "finalized",
      unwrapRequestId,
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      timestamp: event.block.timestamp,
    })
    .onConflictDoUpdate(() => ({ state: "finalized" }));

  await refreshBalance(context, receiver, event.block.number, event.block.timestamp);
});

// --- ACL delegation: lets the holder backfill cleartext for handles it could not decrypt before --
ponder.on("ACL:DelegatedForUserDecryption", async ({ event, context }) => {
  const delegator = event.args.delegator as Address;
  const delegate = event.args.delegate as Address;
  const contractAddress = event.args.contractAddress as Address;
  const newExpirationDate = event.args.newExpirationDate as bigint;
  const id = eventId(event.transaction.hash, event.log.logIndex);

  await context.db
    .insert(aclGrant)
    .values({ id, delegator, delegate, contract: contractAddress, expiration: newExpirationDate, revoked: false, blockNumber: event.block.number })
    .onConflictDoNothing();

  // Only delegations TO the holder, FOR our token, change what we can decrypt.
  if (delegate.toLowerCase() !== HOLDER || contractAddress.toLowerCase() !== TOKEN) return;

  decryptor.registerDelegation(delegator, newExpirationDate);

  // Backfill: retry every handle we previously could not read. Restart-safe (queries the DB, not
  // in-memory state) — see implementation-plan.md §"DelegatedForUserDecryption".
  const stale = await context.db.sql
    .select({ handle: fheHandle.handle })
    .from(fheHandle)
    .where(eq(fheHandle.status, "unauthorized"));

  for (const { handle } of stale) {
    const outcome = await decryptor.tryDecrypt(handle as Hex);
    if (outcome.status === "decrypted") {
      await context.db.update(fheHandle, { handle: handle as Hex }).set({ cleartext: outcome.value, status: "decrypted", lastTriedBlock: event.block.number });
    }
  }
});

ponder.on("ACL:RevokedDelegationForUserDecryption", async ({ event, context }) => {
  const delegate = event.args.delegate as Address;
  const delegator = event.args.delegator as Address;
  if (delegate.toLowerCase() === HOLDER) decryptor.removeDelegation(delegator);

  // Flag the matching grant rows as revoked (read via raw drizzle, write via the tracked store).
  const rows = await context.db.sql
    .select({ id: aclGrant.id })
    .from(aclGrant)
    .where(and(eq(aclGrant.delegator, delegator), eq(aclGrant.delegate, delegate)));
  for (const { id } of rows) {
    await context.db.update(aclGrant, { id }).set({ revoked: true });
  }
});
