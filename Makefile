# Local fhEVM stack runbook for the confidential indexer.
#
# Typical first run (in two terminals):
#   make anvil          # terminal 1: start the local node (keep running)
#   make stack          # terminal 2: materialize host contracts, deploy token
#
# Then copy the printed MOCK_USD_ADDRESS / CONFIDENTIAL_USD_ADDRESS into .env.
#
# Requires: foundry (anvil/forge/cast). Run `make install` once after cloning.

SHELL := /bin/bash
CONTRACTS := contracts
POPULATE := populate
INDEXER := indexer
FORGE_FHEVM := $(CONTRACTS)/lib/forge-fhevm
RPC_URL ?= http://127.0.0.1:8545

# Load .env (if present) so DEPLOYER_PRIVATE_KEY / *_ADDRESS are available to forge.
ifneq (,$(wildcard ./.env))
include .env
export
endif

.PHONY: install build test anvil host deploy stack stack-full populate-install populate indexer-install indexer clean

## Install Solidity dependencies. On a fresh clone: pulls the pinned forge-fhevm submodule, then
## fetches its soldeer dependencies (FHE.sol, OZ confidential-contracts) that remappings.txt points to.
install:
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
host:
	cd $(FORGE_FHEVM) && ./deploy-local.sh --rpc-url "$(RPC_URL)"

## Deploy MockUSD + ConfidentialUSD. Prints addresses to put in .env.
deploy:
	cd $(CONTRACTS) && forge script script/DeployToken.s.sol:DeployToken --rpc-url "$(RPC_URL)" --broadcast

## One-shot: host + deploy (Anvil must already be running via `make anvil`).
## Prints the MOCK_USD_ADDRESS / CONFIDENTIAL_USD_ADDRESS to copy into .env. Run `make populate`
## afterwards (once addresses are in .env) to emit events for the indexer to read.
stack: host deploy

## Install the TypeScript populate script's deps (run once after `make deploy`).
populate-install:
	cd $(POPULATE) && npm install

## Populate the token with the full shield/transfer/unshield mix via the Zama SDK.
## Self-contained: does its own shields, then emits confidential transfers and unshields.
## Requires: Anvil running, host+deploy done, and MOCK_USD_ADDRESS / CONFIDENTIAL_USD_ADDRESS
## filled into .env. Run `make populate-install` once first.
populate:
	cd $(POPULATE) && npm run populate

## One-shot: host + deploy + populate (`stack` plus the SDK-driven event mix).
## Note: addresses must be in .env before `populate` runs; prefer the two-step
## `make host deploy` -> copy addresses -> `make populate` on a first run.
stack-full: host deploy populate

## Install the Ponder indexer's deps (run once).
indexer-install:
	cd $(INDEXER) && npm install

## Run the Ponder indexer + HTTP API (one process: indexes the chain AND serves the API).
## Serves health checks on http://localhost:42069 (/health, /ready, /status, /metrics).
## Requires: Anvil running, host+deploy done, and CONFIDENTIAL_USD_ADDRESS filled into .env.
## Run `make indexer-install` once first. (Optionally `make populate` first for richer events.)
indexer:
	cd $(INDEXER) && npm run dev

## Remove build artifacts.
clean:
	cd $(CONTRACTS) && forge clean
