// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {ConfidentialUSD} from "../src/ConfidentialUSD.sol";

/// @notice Produces real on-chain events for the indexer to consume against the local stack:
///         shields (wrap -> ConfidentialTransfer mint) to two holders. Amounts land as decryptable
///         on-chain plaintexts in the cleartext fhEVM, so the indexer's Zama SDK reads cleartext for
///         the parties with ACL rights.
///
/// @dev    Seeding is deliberately limited to `wrap`, the one path with no cross-transaction FHE
///         handle dependency: `wrap(to, amount)` takes a cleartext amount and trivially-encrypts it
///         inside the token, so no off-chain input proof is needed and each tx is self-contained.
///
///         Confidential transfers and unshield are intentionally NOT seeded here. A Forge *broadcast*
///         script simulates the whole run first, then sends the txs; any tx whose calldata references
///         an FHE handle produced by an earlier tx (e.g. `confidentialTransfer(to, balanceHandle)`)
///         captures the *simulation-time* handle, which does not match the handle the executor derives
///         on-chain — so the ACL check reverts (verified: simulated 0xd086… vs on-chain 0xe9ba…).
///         Those flows need fresh per-tx encrypted inputs / decryption proofs and are generated in the
///         indexer step via the Zama SDK, the natural tool for them against the cleartext relayer.
///
///         Usage (local), after DeployToken populated the addresses in .env:
///           forge script script/Seed.s.sol:Seed --rpc-url "$RPC_URL" --broadcast
contract Seed is Script {
    function run() external {
        ConfidentialUSD cusd = ConfidentialUSD(vm.envAddress("CONFIDENTIAL_USD_ADDRESS"));
        MockUSD usd = MockUSD(vm.envAddress("MOCK_USD_ADDRESS"));

        uint256 funderPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        // Anvil's well-known accounts #1 and #2 by default — toy keys, never real funds.
        uint256 alicePk = vm.envOr(
            "ALICE_PRIVATE_KEY",
            uint256(0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d)
        );
        uint256 bobPk = vm.envOr(
            "BOB_PRIVATE_KEY",
            uint256(0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a)
        );
        address alice = vm.addr(alicePk);
        address bob = vm.addr(bobPk);

        uint256 aliceShield = 1_000_000_000; // 1,000 mUSD (6 decimals)
        uint256 bobShield = 250_000_000; //   250 mUSD

        // Funder mints underlying to itself and shields it to Alice and Bob (1:1 wrap).
        vm.startBroadcast(funderPk);
        usd.mint(vm.addr(funderPk), aliceShield + bobShield);
        usd.approve(address(cusd), aliceShield + bobShield);
        cusd.wrap(alice, aliceShield); // shield -> ConfidentialTransfer(0x0 -> alice)
        cusd.wrap(bob, bobShield); //    shield -> ConfidentialTransfer(0x0 -> bob)
        vm.stopBroadcast();

        console.log("Seeded ConfidentialUSD at %s", address(cusd));
        console.log("  shield -> alice %s : 1000 cUSD", alice);
        console.log("  shield -> bob   %s :  250 cUSD", bob);
    }
}
