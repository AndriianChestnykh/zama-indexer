# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project instructions

### Git hygiene

- **Work on the `main` branch only.** Do not create additional branches; commit directly to `main`.

## Commands

All commands run from the **repo root** (the `Makefile` loads `.env` and exports it). Running `forge` from `contracts/` directly won't pick up the root `.env`.

```bash
# One-time setup
make fhevm-install        # git submodule + soldeer deps for forge-fhevm
cp .env.example .env      # fill in MOCK_USD_ADDRESS / CONFIDENTIAL_USD_ADDRESS after deploy

# Local stack (two terminals)
make anvil                # Terminal 1: local Anvil node, chainId 31337
make fhevm-and-token-deploy   # Terminal 2: materialize fhEVM host contracts + deploy token

# Build / test
make build                # forge build
make test                 # forge test -vv (no node needed)
cd indexer && npm test    # vitest unit tests (no node, no DB)

# Populate, grant, index
make populate-install && make populate    # emit shield/transfer/unshield events via Zama SDK
make grant-install && make grant          # delegate ACL decrypt rights to the indexer holder
make indexer-install                      # once: install Ponder deps
make db-up && make indexer               # start Postgres + run `ponder dev` on localhost:42069

# DB helpers
make db-down    # stop Postgres (data preserved)
make db-reset   # drop volume for clean re-sync
```

## Architecture

### Overview

Three independent sub-packages plus a Foundry contracts project, all reading secrets from a single repo-root `.env`:

| Path | Role |
|------|------|
| `contracts/` | Foundry project: `MockUSD` (plain ERC-20) + `ConfidentialUSD` (ERC-7984 wrapper). `ConfidentialUSD` inherits `ZamaEthereumConfig` — same bytecode works on local-31337 and Sepolia. |
| `populate/` | TypeScript one-shot script (not a Forge script — see below) that drives `@zama-fhe/sdk` to emit the shield / transfer / unshield event mix. |
| `grant/` | Standalone CLI tool: calls `ACL.delegateForUserDecryption` to hand the indexer holder backfill rights. |
| `indexer/` | Ponder 0.16 app: one process that indexes the chain **and** serves the HTTP API on port 42069. |

### Why `populate/` is TypeScript, not a Forge script

Forge broadcast scripts simulate the full run before sending. Any `calldata` that references an FHE handle produced by an earlier tx captures the **simulation-time** handle, which doesn't match the on-chain one produced by the executor — ACL check reverts. The TypeScript SDK produces fresh per-tx encrypted inputs / decryption proofs against the cleartext relayer, avoiding this. Shields (`wrap`) are safe in a Forge script; confidential transfers and unshields are not.

### Indexer internals (`indexer/`)

- **`ponder.config.ts`** — watches two contracts: `ConfidentialUSD` (transfers/unshields) and `ACL` (delegation events). Loads env from the repo-root `.env`.
- **`ponder.schema.ts`** — four logical tables: `fheHandle` (one row per euint64 handle, cleartext nullable), `transaction`, `balance`, `aclGrant`; plus three append-only raw event tables for audit.
- **`src/index.ts`** — event handlers. All decryption happens inline here; no separate worker.
- **`src/decryptor.ts`** — `Decryptor` singleton. Uses `RelayerCleartext` (`@zama-fhe/sdk/cleartext`) which enforces on-chain ACL but reads plaintexts directly from `FHEVMExecutor.plaintexts(handle)`. On Sepolia, swap to `RelayerNode` — call sites are unchanged.
- **`src/config.ts`** — typed env loader; reads `RPC_URL`, `HOLDER_ADDRESS`, `CONFIDENTIAL_USD_ADDRESS`, `ACL_ADDRESS`.
- **`src/logic.ts`** — pure helpers (no I/O): `classifyTransfer`, `amountField`, `direction`, `isAddress`. Unit-tested in `test/logic.test.ts`.
- **`src/api/index.ts`** — Hono HTTP handlers for `/v1/addresses/:address/balance`, `/v1/addresses/:address/transactions`, `/v1/health`.

### Key design decisions

- **One `fheHandle` row per handle**: cleartext lives here only. `transaction` and `balance` reference it by FK. When an ACL grant lets the indexer decrypt a previously-`unauthorized` handle, one `fheHandle.update` propagates to every reader with no secondary copies to sync.
- **`balance` reads latest block** (via a dedicated `balanceClient`), not Ponder's event-pinned client. The forge-fhevm stack can return stale balance handles at historical blocks; reading latest ensures the stored handle is always the live, decryptable one.
- **`unauthorized` amounts are kept, never dropped**: returned in the API with `amount: null` and `amountStatus: "unauthorized"`.
- **ACL delegation triggers a backfill sweep**: on `DelegatedForUserDecryption`, all `unauthorized` handles are retried. The sweep queries the DB (not in-memory state), so it is restart-safe.
- **Unshield is a 2-step flow**: `UnwrapRequested` opens the row with `state: "requested"`; `UnwrapFinalized` closes it and discloses the cleartext (no ACL rights needed). The in-between state surfaces in the API as `state: "pending_finalization"`.

### Local fhEVM stack

`forge-fhevm`'s `deploy-local.sh` materialises fhEVM host contracts onto Anvil via `setCode`/`setStorageAt`. This is a **cleartext fhEVM**: FHE values are plaintexts on-chain. The SDK's `RelayerCleartext` reads them via `FHEVMExecutor.plaintexts(handle)` and still enforces the ACL — no off-chain KMS required for local development.

### Read API

- `GET /v1/addresses/:address/balance` → `{ address, balance, encrypted, amountStatus, handle, blockNumber, updatedAt }`
- `GET /v1/addresses/:address/transactions?limit&cursor` → `{ address, items, nextCursor }` (cursor-paginated)
- `GET /v1/health` → `{ status, chainTipBlock, indexedBlock, blocksBehind, pendingDecryptions }`
- Errors: `{ error: { code, message } }` — 400 for bad address, 404 for unknown.
- `amountStatus`: `decrypted | disclosed | unauthorized | pending`
