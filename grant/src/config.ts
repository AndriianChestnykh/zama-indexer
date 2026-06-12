// Typed, validated config for the standalone grant tool.
//
// Reads the SAME repo-root `.env` everything else uses (two levels up from grant/src). Deliberately
// self-contained — it does NOT import from populate/ — so this tool can be reasoned about and run on
// its own. Mirrors the tiny validator pattern in populate/src/config.ts and indexer/src/config.ts.
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
  aclAddress: asHex("ACL_ADDRESS"),
  confidentialUsdAddress: asHex("CONFIDENTIAL_USD_ADDRESS"),
  /** The indexer holder — the delegate that receives decryption rights. */
  holderAddress: asHex("HOLDER_ADDRESS"),
  alicePrivateKey: asHex("ALICE_PRIVATE_KEY"),
  bobPrivateKey: asHex("BOB_PRIVATE_KEY"),
} as const;
