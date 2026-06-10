// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {ConfidentialUSD} from "../src/ConfidentialUSD.sol";

/// @notice Deploys the underlying MockUSD and the ConfidentialUSD (ERC-7984) wrapper the indexer watches.
/// @dev    Assumes the fhEVM host contracts are already materialized on the target chain
///         (locally via forge-fhevm's `deploy-local.sh`). ConfidentialUSD resolves its coprocessor
///         addresses by chainid through ZamaEthereumConfig, so this same script works on Sepolia too.
///
///         Usage (local):
///           forge script script/DeployToken.s.sol:DeployToken \
///             --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY"
contract DeployToken is Script {
    function run() external returns (MockUSD usd, ConfidentialUSD cusd) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(pk);
        usd = new MockUSD();
        cusd = new ConfidentialUSD(usd);
        vm.stopBroadcast();

        console.log("MockUSD (underlying):       ", address(usd));
        console.log("ConfidentialUSD (cUSD):     ", address(cusd));
        console.log("");
        console.log("Add these to your .env:");
        console.log("  MOCK_USD_ADDRESS=%s", address(usd));
        console.log("  CONFIDENTIAL_USD_ADDRESS=%s", address(cusd));
    }
}
