# Confidential indexer

A TypeScript service that watches a single **ERC-7984** confidential token, auto-decrypts transfer
amounts via the Zama SDK, and serves an ERC-20-style cleartext read API.

This repo currently contains the **on-chain infrastructure** the indexer watches: a local
[fhEVM](https://github.com/zama-ai/fhevm) stack (via [forge-fhevm](https://github.com/zama-ai/forge-fhevm))
plus a deployed confidential token that emits real, decryptable events. The TypeScript indexer/API is
the next step.

All commands below are run **from the repo root** (the `Makefile` lives here and loads `.env`); the
Foundry project itself lives in `contracts/`.

## What's here

| Path | Role |
|------|------|
| `contracts/src/MockUSD.sol` | Plain ERC-20 (6 decimals, open faucet) — the cleartext underlying asset. |
| `contracts/src/ConfidentialUSD.sol` | The watched token: `ERC7984ERC20Wrapper` over MockUSD (`cUSD`). |
| `contracts/script/DeployToken.s.sol` | Deploys both contracts. |
| `contracts/script/Seed.s.sol` | Shields toy balances so the indexer has events to read. |
| `contracts/test/ConfidentialUSD.t.sol` | Happy-path (shield → transfer → decrypt) + negative (no rights → denied). |
| `Makefile` | Runbook targets (`install`, `test`, `anvil`, `stack`, …). |

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
make stack            # = host + deploy + seed
# then copy the printed MOCK_USD_ADDRESS / CONFIDENTIAL_USD_ADDRESS into .env
```

Run the tests (no node needed — they spin up the host contracts in-process):

```bash
make test             # forge test -vv, inside contracts/
```

> The deploy/seed targets read keys and addresses from `.env`. The `Makefile` loads `.env` and exports
> it into the environment before `cd contracts && forge script …`, so Forge sees the variables even
> though `.env` lives at the repo root. Running the `forge` commands by hand from `contracts/` would not
> pick up the root `.env` — use the `make` targets.

## Events the indexer consumes

- `ConfidentialTransfer(from, to, euint64 amount)` — mint (shield, `from = 0x0`), transfer, burn (unshield).
- `IERC7984ERC20Wrapper` unwrap events — `UnwrapRequested` / `UnwrapFinalized` (unshield is a 2-step async flow).
- `AmountDisclosed`, `OperatorSet`.

The `amount` topic is an encrypted handle; cleartext is resolved off-chain by the indexer for the
addresses that hold ACL rights (transfer parties, or a delegatee via `ACL.delegateForUserDecryption`).

## Seeding scope & a forge-script footgun

`Seed.s.sol` only performs `wrap` (shield), because it is the one path with no cross-transaction FHE
handle dependency: `wrap(to, amount)` takes a cleartext amount and trivially-encrypts it inside the token.

Confidential **transfers** and **unshield** are intentionally generated later by the indexer's SDK, not
here. A Forge *broadcast* script simulates the whole run, then sends the txs; any tx whose calldata
references an FHE handle produced by an earlier tx (e.g. `confidentialTransfer(to, balanceHandle)`)
captures the **simulation-time** handle, which does not match the handle the executor derives on-chain,
so the ACL check reverts. Those flows need fresh per-tx encrypted inputs / decryption proofs — exactly
what the `@zama-fhe/sdk` produces against the cleartext relayer.
