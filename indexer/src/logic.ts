// Pure, side-effect-free helpers shared by the indexing functions and the API.
//
// These are the seams that decide the two things the brief cares most about:
//  1. classifying a raw ConfidentialTransfer into shield / transfer / unshield, and
//  2. how an amount surfaces in the API when we *cannot* decrypt it (null + status, never dropped).
// Keeping them pure makes them unit-testable without a chain, a DB, or the Zama SDK (see test/).

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type TransferKind = "shield" | "transfer" | "unshield";

function isZero(addr: string): boolean {
  return addr.toLowerCase() === ZERO_ADDRESS;
}

/**
 * Classify a ConfidentialTransfer by its zero-address legs (see ERC7984._update):
 *  - mint  (from == 0x0) → shield
 *  - burn  (to   == 0x0) → unshield (the burn leg of an unwrap)
 *  - both set            → internal confidential transfer
 */
export function classifyTransfer(from: string, to: string): TransferKind {
  if (isZero(from)) return "shield";
  if (isZero(to)) return "unshield";
  return "transfer";
}

/** Stable per-log id for shield/transfer rows and raw event rows. */
export function eventId(txHash: string, logIndex: number): string {
  return `${txHash}-${logIndex}`;
}

export type HandleView = { cleartext: bigint | null; status: string } | null | undefined;

/**
 * How an amount is rendered in the API. The cleartext is exposed only when the handle is actually
 * known (`decrypted` by our ACL rights, or publicly `disclosed`). Otherwise `amount` is null and we
 * report *why* via `amountStatus` — the row is still returned, never silently dropped.
 */
export function amountField(h: HandleView): { amount: string | null; amountStatus: string } {
  if (h && h.cleartext != null && (h.status === "decrypted" || h.status === "disclosed")) {
    return { amount: h.cleartext.toString(), amountStatus: h.status };
  }
  return { amount: null, amountStatus: h?.status ?? "pending" };
}

/** Map the internal unshield `state` to the partner-facing label that makes the in-between explicit. */
export function unshieldApiState(state: string | null | undefined): string | undefined {
  if (state === "requested") return "pending_finalization";
  if (state === "finalized") return "finalized";
  return undefined;
}

/** Direction of a transaction relative to the address being queried. */
export function direction(
  address: string,
  from: string | null,
  to: string | null,
): "in" | "out" | "self" {
  const a = address.toLowerCase();
  const isFrom = from?.toLowerCase() === a;
  const isTo = to?.toLowerCase() === a;
  if (isFrom && isTo) return "self";
  if (isFrom) return "out";
  return "in";
}

/** Basic 0x-address validation for API input. */
export function isAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}
