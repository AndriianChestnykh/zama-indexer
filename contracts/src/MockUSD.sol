// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSD
/// @notice A plain, openly-mintable ERC-20 used purely as the *underlying* asset that
///         `ConfidentialUSD` wraps. Cleartext token: this is the public side of the
///         shield / unshield boundary. Not for production — anyone can mint toy balances.
/// @dev    6 decimals to mimic a typical USD stablecoin (USDC/USDT).
contract MockUSD is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open faucet for local testing/seeding. No access control by design.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
