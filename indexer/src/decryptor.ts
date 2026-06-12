// The custom core: turning euint64 handles into cleartext using the indexer holder's rights.
//
// On the local forge-fhevm *cleartext* stack the Zama SDK's `RelayerCleartext` is the workhorse:
// `userDecrypt` checks the ACL on-chain (`persistAllowed(handle, signer)` + the token contract) and,
// if allowed, returns the plaintext the executor stores. Crucially it ENFORCES the ACL even in
// cleartext mode — an unauthorized handle throws — so we can faithfully model "the holder only sees
// what it is entitled to" without a real KMS. No signer/private key is needed in cleartext mode
// (the EIP-712 fields are ignored), only the holder's *address*. On Sepolia you would swap
// `RelayerCleartext` for `RelayerNode` and pass a real keypair+signature; the call sites below stay
// the same. See implementation-plan.md §"Decryption module".
import { RelayerCleartext } from "@zama-fhe/sdk/cleartext";
import { hardhat } from "@zama-fhe/sdk/chains";
import type { Address, Hex } from "viem";
import { env } from "./config.js";

export type DecryptOutcome =
  | { status: "decrypted"; value: bigint }
  | { status: "unauthorized" }
  | { status: "pending" }; // transient failure — safe to retry later

// Cleartext relayer ignores the keypair/signature fields, but the typed params require them.
const UNUSED_CRYPTO = {
  signedContractAddresses: [env.confidentialUsdAddress] as Address[],
  privateKey: "0x" as Hex,
  publicKey: "0x" as Hex,
  signature: "0x" as Hex,
  startTimestamp: 0,
  durationDays: 0,
};

function isUnauthorized(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return /not authorized|not allowed|not delegated/i.test(msg);
}

class Decryptor {
  readonly #relayer = new RelayerCleartext({ ...hardhat, network: env.rpcUrl });
  readonly #token = env.confidentialUsdAddress;
  readonly #holder = env.holderAddress;
  /** Terminal cleartext results, so repeated handles (balances especially) don't re-hit the chain. */
  readonly #cache = new Map<string, bigint>();
  /** Active delegators who granted the holder user-decryption rights (delegator -> expiration). */
  readonly #delegators = new Map<string, bigint>();

  /** Record/refresh an ACL delegation to the holder (called from the ACL event handler). */
  registerDelegation(delegator: Address, expiration: bigint): void {
    this.#delegators.set(delegator.toLowerCase(), expiration);
  }

  removeDelegation(delegator: Address): void {
    this.#delegators.delete(delegator.toLowerCase());
  }

  hasDelegations(): boolean {
    return this.#delegators.size > 0;
  }

  async #read(fn: () => Promise<Readonly<Record<string, unknown>>>, handle: string): Promise<bigint> {
    const res = await fn();
    return res[handle] as bigint;
  }

  async #directDecrypt(handle: Hex): Promise<bigint> {
    return this.#read(
      () =>
        this.#relayer.userDecrypt({
          encryptedValues: [handle],
          contractAddress: this.#token,
          signerAddress: this.#holder,
          ...UNUSED_CRYPTO,
        }),
      handle,
    );
  }

  async #delegatedDecrypt(handle: Hex, delegator: string): Promise<bigint> {
    return this.#read(
      () =>
        this.#relayer.delegatedUserDecrypt({
          encryptedValues: [handle],
          contractAddress: this.#token,
          delegatorAddress: delegator as Address,
          delegateAddress: this.#holder,
          ...UNUSED_CRYPTO,
        }),
      handle,
    );
  }

  /**
   * Attempt to decrypt one handle as the holder: first by direct ACL rights (party to the transfer,
   * own balance), then via any recorded delegation. Returns `unauthorized` when we genuinely hold no
   * rights (the negative path the brief cares about), or `pending` on a transient/RPC error.
   */
  async tryDecrypt(handle: Hex): Promise<DecryptOutcome> {
    const cached = this.#cache.get(handle);
    if (cached !== undefined) return { status: "decrypted", value: cached };

    // 1) Direct rights.
    try {
      const value = await this.#directDecrypt(handle);
      this.#cache.set(handle, value);
      return { status: "decrypted", value };
    } catch (err) {
      if (!isUnauthorized(err)) {
        console.warn(`[decrypt] transient failure for ${handle}: ${(err as Error).message}`);
        return { status: "pending" };
      }
    }

    // 2) Delegated rights — try each delegator that granted the holder access.
    for (const delegator of this.#delegators.keys()) {
      try {
        const value = await this.#delegatedDecrypt(handle, delegator);
        this.#cache.set(handle, value);
        return { status: "decrypted", value };
      } catch (err) {
        if (!isUnauthorized(err)) {
          console.warn(`[decrypt] transient delegated failure for ${handle}: ${(err as Error).message}`);
          return { status: "pending" };
        }
      }
    }

    return { status: "unauthorized" };
  }

  dispose(): void {
    this.#relayer.terminate();
  }
}

/** Process-wide singleton, shared by all indexing functions. */
export const decryptor = new Decryptor();
