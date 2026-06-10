// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from
    "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title  ConfidentialUSD (cUSD)
/// @notice The single ERC-7984 confidential token the indexer watches. It wraps `MockUSD`,
///         so it exercises the full event surface the indexer must handle:
///           - shield   : `wrap(to, amount)`   -> mints confidential, emits ConfidentialTransfer(from=0x0)
///           - transfer : `confidentialTransfer*` -> emits ConfidentialTransfer(from, to)
///           - unshield : `unwrap(...)` + `finalizeUnwrap(...)` -> burns, emits Unwrap{Requested,Finalized}
///         All amounts are encrypted euint64 handles; cleartext is resolved off-chain via the SDK.
/// @dev    Inherits `ZamaEthereumConfig`, which selects the FHEVM coprocessor/ACL/KMS addresses by
///         chainid in its constructor (mainnet=1, Sepolia=11155111, local=31337). On the local
///         forge-fhevm stack (chainid 31337) it resolves to the canonical materialized host addresses,
///         so the same bytecode runs locally and on Sepolia without changes.
contract ConfidentialUSD is ERC7984ERC20Wrapper, ZamaEthereumConfig {
    constructor(IERC20 underlying_)
        ERC7984("Confidential USD", "cUSD", "")
        ERC7984ERC20Wrapper(underlying_)
        ZamaEthereumConfig()
    {}
}
