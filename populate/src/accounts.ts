// The three actors in the seed scenario. user1/user2 sign transactions; user3 is
// the "indexer holder" — it only ever *receives* confidential transfers and never
// initiates anything itself.
import { Wallet } from "ethers";
import { env } from "./config.js";

type Hex = `0x${string}`;

export interface Account {
  /** Human label used in logs. */
  label: string;
  privateKey: Hex;
  /** Checksummed EOA address derived from the private key. */
  address: Hex;
}

function account(label: string, privateKey: Hex): Account {
  // No provider needed just to derive the address.
  const address = new Wallet(privateKey).address as Hex;
  return { label, privateKey, address };
}

export const alice = account("alice (user1)", env.alicePrivateKey);
export const bob = account("bob (user2)", env.bobPrivateKey);
export const holder = account("holder (user3, indexer)", env.holderPrivateKey);
