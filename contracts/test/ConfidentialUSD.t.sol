// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Vm} from "forge-std/Vm.sol";
import {FhevmTest} from "forge-fhevm/FhevmTest.sol";

import {euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

import {MockUSD} from "../src/MockUSD.sol";
import {ConfidentialUSD} from "../src/ConfidentialUSD.sol";

/// @title ConfidentialUSD infrastructure test
/// @notice Proves the on-chain half of the indexer's contract: a value shielded into the
///         confidential token, transferred confidentially, and then read back as cleartext by
///         the parties entitled to it — while a third party is correctly denied. This is the
///         Solidity-level analogue of the indexer's happy path (event in -> cleartext out) plus
///         its core negative case (no decryption rights). Runs entirely in-process via
///         forge-fhevm's cleartext host contracts; decrypt/userDecrypt here are the same
///         flows the off-chain Zama SDK performs against the live local chain.
contract ConfidentialUSDTest is FhevmTest {
    uint256 internal constant HOLDER_PK = 0xA11CE;
    uint256 internal constant RECIPIENT_PK = 0xB0B;
    uint256 internal constant THIRD_PARTY_PK = 0xCAFE;

    MockUSD internal usd;
    ConfidentialUSD internal cusd;

    address internal holder;
    address internal recipient;
    address internal thirdParty;

    function setUp() public override {
        super.setUp();

        holder = vm.addr(HOLDER_PK);
        recipient = vm.addr(RECIPIENT_PK);
        thirdParty = vm.addr(THIRD_PARTY_PK);

        usd = new MockUSD();
        cusd = new ConfidentialUSD(usd);

        // MockUSD has 6 decimals and the wrapper caps at 6, so wrapping is 1:1.
        assertEq(cusd.rate(), 1);
        assertEq(cusd.decimals(), 6);
    }

    /// @notice Shield: wrapping MockUSD mints a confidential balance the holder can decrypt.
    function test_shield_mintsDecryptableBalance() public {
        _shield(holder, 1_000);
        assertEq(_decryptBalance(HOLDER_PK, holder), 1_000);
    }

    /// @notice Happy path the indexer mirrors: after a confidential transfer, the recipient's
    ///         balance and the transfer-amount handle emitted in the event both decrypt to cleartext.
    function test_confidentialTransfer_recipientReadsCleartext() public {
        _shield(holder, 1_000);

        // Record logs across the transfer so we can pull the encrypted amount out of the event,
        // exactly as the indexer does when it sees a ConfidentialTransfer.
        _processNewLogs();
        vm.recordLogs();

        (externalEuint64 amount, bytes memory proof) = encryptUint64(400, holder, address(cusd));
        vm.prank(holder);
        cusd.confidentialTransfer(recipient, amount, proof);

        euint64 transferAmount = _transferAmountHandle(getRecordedLogs());

        // Balances reconcile in cleartext.
        assertEq(_decryptBalance(HOLDER_PK, holder), 600);
        assertEq(_decryptBalance(RECIPIENT_PK, recipient), 400);

        // The event's amount handle is decryptable by the recipient (a party to the transfer).
        assertEq(_decryptHandle(RECIPIENT_PK, recipient, transferAmount), 400);
    }

    /// @notice Negative case: a party with no ACL rights on the transfer amount cannot decrypt it.
    ///         The indexer must surface such events as "amount unavailable", never as zero/dropped.
    ///         Chosen because it is the exact failure the indexer must handle gracefully — an event
    ///         it is not (yet) entitled to read.
    function test_thirdPartyCannotDecryptTransferAmount() public {
        _shield(holder, 1_000);

        _processNewLogs();
        vm.recordLogs();
        (externalEuint64 amount, bytes memory proof) = encryptUint64(400, holder, address(cusd));
        vm.prank(holder);
        cusd.confidentialTransfer(recipient, amount, proof);

        bytes32 handle = euint64.unwrap(_transferAmountHandle(getRecordedLogs()));
        bytes memory signature = signUserDecrypt(THIRD_PARTY_PK, address(cusd));

        vm.expectRevert(abi.encodeWithSelector(FhevmTest.UserNotAuthorizedForDecrypt.selector, handle, thirdParty));
        this.callUserDecrypt(handle, thirdParty, address(cusd), signature);
    }

    // --- helpers -----------------------------------------------------------------------------

    /// @notice Mint underlying MockUSD to `to` and wrap it 1:1 into ConfidentialUSD (shield).
    function _shield(address to, uint256 amount) internal {
        usd.mint(to, amount);
        vm.startPrank(to);
        usd.approve(address(cusd), amount);
        cusd.wrap(to, amount);
        vm.stopPrank();
    }

    function _decryptBalance(uint256 pk, address account) internal returns (uint64) {
        return _decryptHandle(pk, account, cusd.confidentialBalanceOf(account));
    }

    function _decryptHandle(uint256 pk, address user, euint64 handle) internal returns (uint64) {
        bytes memory signature = signUserDecrypt(pk, address(cusd));
        return uint64(userDecrypt(euint64.unwrap(handle), user, address(cusd), signature));
    }

    /// @dev External trampoline so `vm.expectRevert` can target the internal `userDecrypt`.
    function callUserDecrypt(bytes32 handle, address user, address contractAddress, bytes memory userSignature)
        external
        returns (uint256)
    {
        return userDecrypt(handle, user, contractAddress, userSignature);
    }

    /// @dev The ConfidentialTransfer event carries the encrypted amount as its 4th (indexed) topic.
    function _transferAmountHandle(Vm.Log[] memory logs) internal view returns (euint64) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(cusd) && logs[i].topics[0] == IERC7984.ConfidentialTransfer.selector) {
                return euint64.wrap(logs[i].topics[3]);
            }
        }
        revert("ConfidentialTransfer event not found");
    }
}
