# Local fhEVM stack runbook for the confidential indexer.
#
# Typical first run (in two terminals):
#   make anvil                     # terminal 1: start the local node (keep running)
#   make fhevm-and-token-deploy    # terminal 2: materialize host contracts, deploy token
#
# Then copy the printed MOCK_USD_ADDRESS / CONFIDENTIAL_USD_ADDRESS into .env.
#
# Requires: foundry (anvil/forge/cast). Run `make fhevm-install` once after cloning.

SHELL := /bin/bash
CONTRACTS := contracts
POPULATE := populate
GRANT := grant
INDEXER := indexer
FORGE_FHEVM := $(CONTRACTS)/lib/forge-fhevm
RPC_URL ?= http://127.0.0.1:8545

# Load .env (if present) so DEPLOYER_PRIVATE_KEY / *_ADDRESS are available to forge.
ifneq (,$(wildcard ./.env))
include .env
export
endif

.PHONY: fhevm-install build test anvil fhevm-deploy token-deploy fhevm-and-token-deploy stack-full populate-install populate grant-install grant db-up db-down db-reset db-logs indexer-install indexer clean

## Install Solidity dependencies. On a fresh clone: pulls the pinned forge-fhevm submodule, then
## fetches its soldeer dependencies (FHE.sol, OZ confidential-contracts) that remappings.txt points to.
fhevm-install:
	git submodule update --init --recursive
	cd $(FORGE_FHEVM) && forge soldeer install

## Compile contracts.
build:
	cd $(CONTRACTS) && forge build

## Run the Foundry happy-path + negative test (in-process, no node needed).
test:
	cd $(CONTRACTS) && forge test -vv

## Terminal 1: start a local Anvil node (chainId 31337). Keep this running.
anvil:
	anvil

## Materialize the fhEVM host contracts (ACL/Executor/InputVerifier/KMSVerifier) onto Anvil.
fhevm-deploy:
	cd $(FORGE_FHEVM) && ./deploy-local.sh --rpc-url "$(RPC_URL)"

## Deploy MockUSD + ConfidentialUSD. Prints addresses to put in .env.
token-deploy:
	cd $(CONTRACTS) && forge script script/DeployToken.s.sol:DeployToken --rpc-url "$(RPC_URL)" --broadcast

## One-shot: host + deploy (Anvil must already be running via `make anvil`).
## Prints the MOCK_USD_ADDRESS / CONFIDENTIAL_USD_ADDRESS to copy into .env. Run `make populate`
## afterwards (once addresses are in .env) to emit events for the indexer to read.
fhevm-and-token-deploy: fhevm-deploy token-deploy

## Install the TypeScript populate script's deps (run once after `make deploy`).
populate-install:
	cd $(POPULATE) && npm install

## Populate the token with the full shield/transfer/unshield mix via the Zama SDK.
## Self-contained: does its own shields, then emits confidential transfers and unshields.
## Requires: Anvil running, host+deploy done, and MOCK_USD_ADDRESS / CONFIDENTIAL_USD_ADDRESS
## filled into .env. Run `make populate-install` once first.
populate:
	cd $(POPULATE) && npm run populate

## Install the grant tool's deps (run once).
grant-install:
	cd $(GRANT) && npm install

## Delegate user-decryption rights to the indexer holder, so the indexer backfills cleartext for
## amounts it previously could not read. Independent of `populate` — run it whenever, after deploy.
## Usage: `make grant` (Alice grants), `make grant ARGS=bob`, `make grant ARGS=0x<privkey>`,
##        `make grant ARGS="alice --days=30"`. Run `make grant-install` once first.
grant:
	cd $(GRANT) && npm run grant -- $(ARGS)

## One-shot: host + deploy + populate (`fhevm-and-token-deploy` plus the SDK-driven event mix).
## Note: addresses must be in .env before `populate` runs; prefer the two-step
## `make fhevm-deploy token-deploy` -> copy addresses -> `make populate` on a first run.
stack-full: fhevm-deploy token-deploy populate

## Start the Dockerized Postgres the indexer persists to; blocks until it's healthy.
## The connection string lives in .env (DATABASE_URL) and matches docker-compose.yml.
db-up:
	docker compose up -d --wait postgres

## Stop Postgres (the named volume / data is preserved across restarts).
db-down:
	docker compose down

## Stop Postgres AND drop its volume — forces a clean re-sync from INDEXER_START_BLOCK.
db-reset:
	docker compose down -v

## Tail the Postgres logs.
db-logs:
	docker compose logs -f postgres

## Install the Ponder indexer's deps (run once).
indexer-install:
	cd $(INDEXER) && npm install

## Run the Ponder indexer + HTTP API (one process: indexes the chain AND serves the API).
## Serves health checks on http://localhost:42069 (/health, /ready, /status, /metrics).
## Requires: Postgres up (`make db-up`), Anvil running, host+deploy done, and
## CONFIDENTIAL_USD_ADDRESS filled into .env. Run `make indexer-install` once first.
## (Optionally `make populate` first for richer events.)
indexer:
	cd $(INDEXER) && npm run dev

## Remove build artifacts.
clean:
	cd $(CONTRACTS) && forge clean
