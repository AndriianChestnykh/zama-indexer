// Typed, validated config for the indexer process.
//
// Loads the SAME repo-root `.env` the Makefile / populate / ponder.config all use (two levels
// up from indexer/src), so there is one source of truth for addresses and keys. Imported by the
// decryptor, the indexing functions, and the API.
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
loadEnv({ path: resolve(repoRoot, ".env") });

type Hex = `0x${string}`;

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required env var ${name}. Populate it in the repo-root .env ` +
        `(run \`make deploy\` and copy the printed addresses).`,
    );
  }
  return value.trim();
}

function asHex(name: string): Hex {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Env var ${name} must be a 0x-prefixed hex string, got: ${value}`);
  }
  return value as Hex;
}

export const LOCAL_CHAIN_ID = 31337;

export const env = {
  rpcUrl: required("RPC_URL"),
  /** The indexer holder — the only party whose decryption rights we hold (account #3). */
  holderAddress: asHex("HOLDER_ADDRESS"),
  confidentialUsdAddress: asHex("CONFIDENTIAL_USD_ADDRESS"),
  aclAddress: asHex("ACL_ADDRESS"),
} as const;
