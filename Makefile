# Local fhEVM stack runbook for the confidential indexer.
#
# Typical first run (in two terminals):
#   make anvil          # terminal 1: start the local node (keep running)
#   make stack          # terminal 2: materialize host contracts, deploy token, seed events
#
# Then copy the printed MOCK_USD_ADDRESS / CONFIDENTIAL_USD_ADDRESS into .env.
#
# Requires: foundry (anvil/forge/cast). Run `make install` once after cloning.

SHELL := /bin/bash
CONTRACTS := contracts
FORGE_FHEVM := $(CONTRACTS)/lib/forge-fhevm
RPC_URL ?= http://127.0.0.1:8545

# Load .env (if present) so DEPLOYER_PRIVATE_KEY / *_ADDRESS are available to forge.
ifneq (,$(wildcard ./.env))
include .env
export
endif

.PHONY: install build test anvil host deploy seed stack clean

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

## Shield toy balances to seed accounts so the indexer has events to read.
seed:
	cd $(CONTRACTS) && forge script script/Seed.s.sol:Seed --rpc-url "$(RPC_URL)" --broadcast

## One-shot: host + deploy + seed (Anvil must already be running via `make anvil`).
stack: host deploy seed

## Remove build artifacts.
clean:
	cd $(CONTRACTS) && forge clean
