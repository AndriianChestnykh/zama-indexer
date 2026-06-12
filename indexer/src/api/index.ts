// HTTP read API for the wallet partner. Cleartext where we have it, an explicit status where we
// don't, and a health endpoint that says how far behind we are. Endpoint shapes are our design
// (see implementation-plan.md §"Read API"). Ponder also serves its built-in /health, /ready,
// /status, /metrics on the same server.
import { Hono } from "hono";
import { and, count, desc, eq, inArray, lt, or, sql } from "ponder";
import { db } from "ponder:api";
import {
  balance,
  confidentialTransferEvent,
  fheHandle,
  transaction,
  unwrapFinalizedEvent,
} from "ponder:schema";
import { createPublicClient, http } from "viem";
import { env } from "../config.js";
import { amountField, direction, isAddress, unshieldApiState } from "../logic.js";

const app = new Hono();

const publicClient = createPublicClient({ transport: http(env.rpcUrl) });

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

function badRequest(c: any, message: string) {
  return c.json({ error: { code: "bad_request", message } }, 400);
}

/**
 * GET /v1/health — liveness + how far behind the chain tip we are, plus how many amounts are still
 * undecrypted. Complements Ponder's built-in /ready and /status (which report sync internals).
 */
app.get("/v1/health", async (c) => {
  // Last block we actually wrote an event for — taken from the append-only raw tables (which
  // record every event at its true block), not `transaction` (whose unshield rows keep their
  // request block when finalized).
  const [tip, ctMax, ufMax, pending] = await Promise.all([
    publicClient.getBlockNumber().catch(() => null),
    db.select({ b: sql<bigint | null>`max(${confidentialTransferEvent.blockNumber})` }).from(confidentialTransferEvent),
    db.select({ b: sql<bigint | null>`max(${unwrapFinalizedEvent.blockNumber})` }).from(unwrapFinalizedEvent),
    db.select({ n: count() }).from(fheHandle).where(inArray(fheHandle.status, ["pending", "unauthorized"])),
  ]);

  const blocks = [ctMax[0]?.b, ufMax[0]?.b].filter((b): b is bigint => b != null).map(BigInt);
  const indexedBlock = blocks.length ? blocks.reduce((a, b) => (a > b ? a : b)) : null;
  const blocksBehind = tip !== null && indexedBlock !== null ? Number(tip - indexedBlock) : null;
  return c.json({
    status: tip === null ? "degraded" : "ok",
    chainTipBlock: tip !== null ? tip.toString() : null,
    indexedBlock: indexedBlock !== null ? indexedBlock.toString() : null,
    blocksBehind,
    pendingDecryptions: pending[0]?.n ?? 0,
  });
});

/** GET /v1/addresses/:address/balance — current cleartext balance, or encrypted/unknown. */
app.get("/v1/addresses/:address/balance", async (c) => {
  const address = c.req.param("address").toLowerCase();
  if (!isAddress(address)) return badRequest(c, "address must be a 0x-prefixed 20-byte hex string");

  const [row] = await db.select().from(balance).where(eq(balance.address, address as `0x${string}`)).limit(1);
  if (!row) {
    return c.json({ error: { code: "not_found", message: "no balance indexed for this address" } }, 404);
  }

  const [handle] = await db.select().from(fheHandle).where(eq(fheHandle.handle, row.handle)).limit(1);
  const { amount, amountStatus } = amountField(handle);
  return c.json({
    address,
    balance: amount,
    encrypted: amount === null,
    amountStatus,
    handle: row.handle,
    blockNumber: row.blockNumber.toString(),
    updatedAt: row.updatedAt.toString(),
  });
});

/**
 * GET /v1/addresses/:address/transactions?limit&cursor — cleartext-where-available history.
 * Cursor is keyed on (blockNumber, id) for stable pagination; undecryptable amounts come back as
 * `amount: null` with `amountStatus`, never dropped.
 */
app.get("/v1/addresses/:address/transactions", async (c) => {
  const address = c.req.param("address").toLowerCase();
  if (!isAddress(address)) return badRequest(c, "address must be a 0x-prefixed 20-byte hex string");

  const limitRaw = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
    return badRequest(c, `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }

  const addr = address as `0x${string}`;
  const involves = or(eq(transaction.from, addr), eq(transaction.to, addr));

  // Cursor: "<blockNumber>:<id>" — fetch strictly older rows for descending order.
  let where = involves;
  const cursor = c.req.query("cursor");
  if (cursor) {
    const sep = cursor.indexOf(":");
    if (sep === -1) return badRequest(c, "invalid cursor");
    const cBlock = BigInt(cursor.slice(0, sep));
    const cId = cursor.slice(sep + 1);
    where = and(
      involves,
      or(lt(transaction.blockNumber, cBlock), and(eq(transaction.blockNumber, cBlock), lt(transaction.id, cId))),
    )!;
  }

  const rows = await db
    .select()
    .from(transaction)
    .where(where)
    .orderBy(desc(transaction.blockNumber), desc(transaction.id))
    .limit(limitRaw + 1);

  const page = rows.slice(0, limitRaw);
  const handles = await Promise.all(
    page.map((r) => db.select().from(fheHandle).where(eq(fheHandle.handle, r.amountHandle)).limit(1)),
  );

  const items = page.map((r, i) => {
    const { amount, amountStatus } = amountField(handles[i]?.[0]);
    return {
      id: r.id,
      type: r.type,
      direction: direction(address, r.from, r.to),
      from: r.from,
      to: r.to,
      amount,
      amountStatus,
      ...(r.type === "unshield" ? { state: unshieldApiState(r.state) } : {}),
      txHash: r.txHash,
      blockNumber: r.blockNumber.toString(),
      logIndex: r.logIndex,
      timestamp: r.timestamp.toString(),
    };
  });

  const last = page[page.length - 1];
  const nextCursor = rows.length > limitRaw && last ? `${last.blockNumber.toString()}:${last.id}` : null;
  return c.json({ address, items, nextCursor });
});

export default app;
