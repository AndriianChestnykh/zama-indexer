// Loads the repo-root `.env` (the same file the Makefile sources) and exposes a
// typed, validated config. This package lives in `populate/`, so the env file is
// two levels up from `populate/src`.
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
loadEnv({ path: resolve(repoRoot, ".env") });

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

type Hex = `0x${string}`;

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
  deployerPrivateKey: asHex("DEPLOYER_PRIVATE_KEY"),
  alicePrivateKey: asHex("ALICE_PRIVATE_KEY"),
  bobPrivateKey: asHex("BOB_PRIVATE_KEY"),
  holderPrivateKey: asHex("HOLDER_PRIVATE_KEY"),
  confidentialUsdAddress: asHex("CONFIDENTIAL_USD_ADDRESS"),
  mockUsdAddress: asHex("MOCK_USD_ADDRESS"),
} as const;
