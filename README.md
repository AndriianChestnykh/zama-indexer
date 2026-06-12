# Confidential indexer

A TypeScript service that watches a single **ERC-7984** confidential token, auto-decrypts transfer
amounts via the Zama SDK, and serves an ERC-20-style cleartext read API.

This repo contains the **on-chain infrastructure** the indexer watches — a local
[fhEVM](https://github.com/zama-ai/fhevm) stack (via [forge-fhevm](https://github.com/zama-ai/forge-fhevm))
plus a deployed confidential token that emits real, decryptable events — and the
[Ponder](https://ponder.sh) **indexer/API service** (`indexer/`). The service indexes shields,
confidential transfers, and unshields; decrypts every amount the indexer holder is entitled to (as a
party to the transfer or via an ACL delegation); and serves a cleartext-where-available read API.

All commands below are run **from the repo root** (the `Makefile` lives here and loads `.env`); the
Foundry project itself lives in `contracts/`.

## What's here

| Path | Role |
|------|------|
| `contracts/src/MockUSD.sol` | Plain ERC-20 (6 decimals, open faucet) — the cleartext underlying asset. |
| `contracts/src/ConfidentialUSD.sol` | The watched token: `ERC7984ERC20Wrapper` over MockUSD (`cUSD`). |
| `contracts/script/DeployToken.s.sol` | Deploys both contracts. |
| `contracts/test/ConfidentialUSD.t.sol` | Happy-path (shield → transfer → decrypt) + negative (no rights → denied). |
| `populate/` | TypeScript script that drives the Zama SDK to emit the full shield/transfer/unshield mix. |
| `indexer/` | Ponder indexer + HTTP API (one process): decrypts amounts and serves balance/transaction/health endpoints. |
| `Makefile` | Runbook targets (`install`, `test`, `anvil`, `stack`, `populate`, `indexer`, …). |

Inside `indexer/`: `ponder.schema.ts` (tables), `src/index.ts` (event handlers), `src/decryptor.ts`
(the Zama-SDK decryption core), `src/api/index.ts` (read API), `src/logic.ts` + `test/` (pure helpers
and their unit tests).

`ConfidentialUSD` inherits `ZamaEthereumConfig`, which picks the fhEVM coprocessor/ACL/KMS addresses
by **chainid** at construction (mainnet / Sepolia / local-31337). The same bytecode runs on the local
stack and on Sepolia with no change.

## How the local stack works

`forge-fhevm`'s `deploy-local.sh` materializes the fhEVM host contracts (ACL, FHEVMExecutor,
InputVerifier, KMSVerifier) onto Anvil at their canonical addresses via `setCode`/`setStorageAt`. It is
a **cleartext fhEVM**: FHE values are stored as on-chain plaintexts (nothing is actually encrypted).
The indexer's `@zama-fhe/sdk` uses its `cleartext()` relayer transport to read those plaintexts directly
from the executor — **no off-chain relayer/KMS is required**. (Verified: an `euint64` balance handle
resolves through `FHEVMExecutor.plaintexts(handle)` to its cleartext value.)

## Quick start

Requires [Foundry](https://book.getfoundry.sh/) (`anvil`, `forge`, `cast`). All commands run from the repo root.

```bash
make install          # pull the pinned forge-fhevm submodule + its soldeer deps
cp .env.example .env  # toy Anvil keys; never put real keys here

# Terminal 1 — local node (keep running):
make anvil

# Terminal 2 — bring up the stack:
make stack            # = host + deploy (prints token addresses)
# then copy the printed MOCK_USD_ADDRESS / CONFIDENTIAL_USD_ADDRESS into .env
```

Run the tests:

```bash
make test                       # Solidity: forge test -vv, inside contracts/ (spins up host contracts in-process)
cd indexer && npm test          # TypeScript: vitest — happy path + unauthorized-not-dropped
```

Run the indexer + API service (needs Anvil up, the token deployed, and
`CONFIDENTIAL_USD_ADDRESS` in `.env`; run `make populate` first so there are events to read):

```bash
make indexer-install   # once: install indexer/ (Ponder) deps
make db-up             # start the Dockerized Postgres (waits until healthy)
make indexer           # ponder dev — indexes the chain AND serves the API in one process
```

The service listens on `localhost:42069`. The partner-facing read API (using `HOLDER_ADDRESS` from
`.env` as the example):

```bash
H=0x90F79bf6EB2c4f870365E785982E1f101E93b906   # the indexer holder

# Current cleartext balance (or encrypted:true when the holder has no rights):
curl "localhost:42069/v1/addresses/$H/balance"

# Transfer history, cleartext where available, cursor-paginated:
curl "localhost:42069/v1/addresses/$H/transactions?limit=25"

# Health: how far behind the chain tip, and how many amounts are still undecrypted:
curl "localhost:42069/v1/health"
```

Ponder's built-in `/health`, `/ready`, `/status`, `/metrics` remain available alongside the `/v1` routes.

The indexer persists to Postgres (run in Docker via `docker-compose.yml`) — `DATABASE_URL` in
`.env` points at it. `make db-down` stops it (data preserved); `make db-reset` drops the volume for
a clean re-sync. Unset `DATABASE_URL` to fall back to Ponder's embedded PGLite store.

> The deploy target reads keys and addresses from `.env`. The `Makefile` loads `.env` and exports
> it into the environment before `cd contracts && forge script …`, so Forge sees the variables even
> though `.env` lives at the repo root. Running the `forge` commands by hand from `contracts/` would not
> pick up the root `.env` — use the `make` targets.

## Events the indexer consumes

- `ConfidentialTransfer(from, to, euint64 amount)` — mint (shield, `from = 0x0`), transfer, burn (unshield, `to = 0x0`).
- `UnwrapRequested` / `UnwrapFinalized` — unshield is a 2-step async flow; `UnwrapFinalized` carries the
  cleartext amount publicly, so unshield amounts are always shown regardless of decryption rights.
- ACL `DelegatedForUserDecryption` / `RevokedDelegationForUserDecryption` — a partner granting (or
  revoking) the holder's decryption rights; a new grant triggers a backfill of previously-undecryptable amounts.

The `amount` topic is an encrypted handle; cleartext is resolved off-chain by the indexer for the
addresses that hold ACL rights (transfer parties, or a delegatee via `ACL.delegateForUserDecryption`).

## Read API and the decryption model

The indexer holds the decryption rights of a single address (`HOLDER_ADDRESS`). It can decrypt an
amount only when that holder is **a party to the transfer** (`from`/`to`/`receiver`), is reading **its
own balance**, or has been **delegated** rights via the ACL. Everything else stays encrypted — but is
still indexed and returned, never silently dropped.

- `GET /v1/addresses/:address/balance` → `{ address, balance, encrypted, amountStatus, handle, blockNumber, updatedAt }`.
  `balance` is a decimal string, or `null` with `encrypted: true` when the holder can't decrypt it.
- `GET /v1/addresses/:address/transactions?limit&cursor` → `{ address, items, nextCursor }`. Each item is
  `{ id, type, direction, from, to, amount, amountStatus, state?, txHash, blockNumber, logIndex, timestamp }`.
  `amount` is a decimal string or `null`; `amountStatus` is one of `decrypted | disclosed | unauthorized | pending`.
  Unshields carry `state: "pending_finalization" | "finalized"` to surface the in-between state where the
  ERC-7984 balance is already debited but the underlying ERC-20 has not yet been delivered.
- `GET /v1/health` → `{ status, chainTipBlock, indexedBlock, blocksBehind, pendingDecryptions }`.

Errors use `{ error: { code, message } }`: `400` for a malformed address, `404` for an unknown one.

## Granting decrypt rights later (the backfill demo)

The indexer can only decrypt what the holder is entitled to — so amounts between *other* parties come
back `unauthorized`. A partner can grant the holder decryption rights after the fact via the fhEVM ACL,
and the indexer backfills cleartext for the now-readable handles. The standalone [`grant/`](grant/) tool
emits that grant; it is independent of `populate/` and can be run at any time after deploy.

```bash
make grant-install      # once: install grant/ deps
make grant              # Alice delegates decrypt rights to the indexer holder (default)
make grant ARGS=bob     # Bob instead
make grant ARGS=0x<privkey>          # any address (its key signs the grant)
make grant ARGS="alice --days=30"    # custom delegation lifetime (default 365 days)
```

Demo flow with the indexer running:

```bash
A=0x70997970C51812dc3A010C7d01b50e0d17dc79C8     # alice
curl "localhost:42069/v1/addresses/$A/transactions?limit=100"   # before: alice<->bob amounts are "unauthorized"
make grant                                                       # alice grants to the holder
curl "localhost:42069/v1/addresses/$A/transactions?limit=100"   # after:  those amounts are now "decrypted"
```

Under the hood `grant/` calls `ACL.delegateForUserDecryption(holder, cUSD, expiration)` signed by the
delegator; that emits `DelegatedForUserDecryption`, which the indexer's ACL handler turns into a
re-decryption sweep of every handle the delegator is authorized on.

## Why the event mix is a TypeScript script (a forge-script footgun)

The whole shield / confidential-transfer / unshield mix is generated by a standalone TypeScript script in
[`populate/`](populate/) — not a Forge script — because of an FHE-handle footgun.

A Forge *broadcast* script simulates the whole run, then sends the txs; any tx whose calldata references
an FHE handle produced by an earlier tx (e.g. `confidentialTransfer(to, balanceHandle)`) captures the
**simulation-time** handle, which does not match the handle the executor derives on-chain, so the ACL
check reverts. (Shields are the exception — `wrap(to, amount)` takes a cleartext amount and
trivially-encrypts it inside the token, with no cross-tx handle dependency.) Confidential transfers and
unshield need fresh per-tx encrypted inputs / decryption proofs — exactly what the `@zama-fhe/sdk`
produces against the cleartext relayer.

So `populate/` drives the SDK (`RelayerCleartext` transport, no off-chain relayer needed):

```bash
make populate-install   # once: install populate/ deps
make populate           # shields + 27 confidential transfers + 3 unshields via the SDK
```

It produces the scenario from `indexer-impl-task.md`: user1 (alice) — 2 shields, 5 spends → user2,
7 spends → user3, 1 unshield; user2 (bob) — 1 shield, 5 spends → user3, 10 spends → user1, 2 unshields;
user3 (the indexer holder) only receives. Each unshield is asserted to have released the underlying mUSD
(the 2-step `unwrap` → `finalizeUnwrap` actually completed). It is self-contained — it does its own
shields — and only requires `make host && make deploy` done with the printed addresses copied into `.env`.
