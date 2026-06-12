// Ponder configuration for the ConfidentialUSD indexer.
//
// One Ponder process both indexes the chain (polling via the `http` transport — no event
// subscriptions, matching implementation-plan.md's design decision) and serves the HTTP API.
// For item 2 the API is health-checks-only: we register NO custom routes (no `src/api/index.ts`),
// so only Ponder's built-in /health, /ready, /status endpoints exist.
//
// Config/secrets come from the SAME repo-root `.env` the Makefile and `populate/` already use,
// loaded here with the same dotenv pattern as `populate/src/config.ts` (rather than a duplicate
// `indexer/.env.local`). Storage is Postgres: Ponder auto-selects it when DATABASE_URL is set
// (see repo-root .env + docker-compose.yml; `make db-up`), falling back to embedded PGLite if not.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { createConfig } from "ponder";
import { AclAbi } from "./abis/AclAbi";
import { ConfidentialUsdAbi } from "./abis/ConfidentialUsdAbi";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
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

const LOCAL_CHAIN_ID = 31337;
const rpcUrl = required("RPC_URL");
const confidentialUsdAddress = required("CONFIDENTIAL_USD_ADDRESS") as `0x${string}`;
const aclAddress = required("ACL_ADDRESS") as `0x${string}`;
const startBlock = Number(process.env.INDEXER_START_BLOCK ?? "0");
const pollingInterval = Number(process.env.POLL_INTERVAL_MS ?? "2000");

export default createConfig({
  chains: {
    local: {
      id: LOCAL_CHAIN_ID,
      rpc: rpcUrl,
      pollingInterval,
    },
  },
  contracts: {
    // The confidential token: shields, transfers, and unshields.
    ConfidentialUSD: {
      chain: "local",
      abi: ConfidentialUsdAbi,
      address: confidentialUsdAddress,
      startBlock,
    },
    // The fhEVM ACL: indexed only for user-decryption delegations, which let the holder
    // backfill cleartext for handles it previously could not decrypt.
    ACL: {
      chain: "local",
      abi: AclAbi,
      address: aclAddress,
      startBlock,
    },
  },
});
