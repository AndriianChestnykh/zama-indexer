// Populate ConfidentialUSD with the full shield / confidential-transfer / unshield mix
// from implementation-plan.md §1.3, so the indexer has a realistic event history to read.
//
// Unlike contracts/script/Seed.s.sol (shield-only — a Forge broadcast script can't carry
// the per-tx FHE handles that transfers/unshields need), this runs against the live local
// stack via the Zama SDK, which builds fresh encrypted inputs and decryption proofs per tx.
//
// Prereqs: Anvil up (`make anvil`), `make host && make deploy` done, and the printed
// MOCK_USD_ADDRESS / CONFIDENTIAL_USD_ADDRESS copied into the repo-root .env.
import { Contract, Wallet } from "ethers";
import { env, LOCAL_CHAIN_ID } from "./config.js";
import { alice, bob, holder, type Account } from "./accounts.js";
import {
  ALICE_SHIELD,
  BOB_SHIELD,
  SPEND,
  UNSHIELD,
  counts,
  funding,
  assertSolvent,
  fmt,
} from "./amounts.js";
import { buildSdkForAccount, disposeRelayer, provider, type AccountSdk } from "./sdk.js";

const MOCK_USD_ABI = [
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
] as const;

let step = 0;
function log(phase: string, msg: string): void {
  step += 1;
  console.log(`[${String(step).padStart(2, "0")}] ${phase.padEnd(9)} ${msg}`);
}

function short(hash: string): string {
  return `${hash.slice(0, 10)}…`;
}

/** Run `n` confidential transfers of `amount` from one signer to a fixed recipient. */
async function spend(from: AccountSdk, to: Account, amount: bigint, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    // We control the amounts (see assertSolvent), so skip the SDK's decrypt-to-validate
    // balance check — it would add an EIP-712/userDecrypt round-trip per transfer.
    const { txHash } = await from.token.confidentialTransfer(to.address, amount, {
      skipBalanceCheck: true,
    });
    log("transfer", `${from.account.label} -> ${to.label}  ${fmt(amount)} cUSD  (${i}/${n})  ${short(txHash)}`);
  }
}

/** Unshield `amount` and assert the signer's underlying mUSD actually increased. */
async function unshield(actor: AccountSdk, mockUsd: Contract, amount: bigint, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    const before = (await mockUsd.balanceOf(actor.account.address)) as bigint;
    const { txHash } = await actor.token.unshield(amount, { skipBalanceCheck: true });
    const after = (await mockUsd.balanceOf(actor.account.address)) as bigint;
    const delta = after - before;
    if (delta !== amount) {
      throw new Error(
        `Unshield did not finalize for ${actor.account.label}: mUSD delta ${fmt(delta)} != ${fmt(amount)}. ` +
          `The 2-step unwrap/finalizeUnwrap likely did not complete against the cleartext stack.`,
      );
    }
    log("unshield", `${actor.account.label}  ${fmt(amount)} cUSD -> mUSD  (${i}/${n})  ${short(txHash)}  ✓ +${fmt(delta)} mUSD`);
  }
}

async function main(): Promise<void> {
  assertSolvent();

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== LOCAL_CHAIN_ID) {
    throw new Error(
      `Expected the local cleartext stack (chainId ${LOCAL_CHAIN_ID}) but RPC ${env.rpcUrl} is chainId ${net.chainId}. ` +
        `This script only targets the forge-fhevm local stack.`,
    );
  }

  console.log(`\nPopulating ConfidentialUSD ${env.confidentialUsdAddress} on chainId ${LOCAL_CHAIN_ID}`);
  console.log(`  user1 ${alice.address}  (alice)`);
  console.log(`  user2 ${bob.address}  (bob)`);
  console.log(`  user3 ${holder.address}  (indexer holder — receives only)\n`);

  const aliceSdk = buildSdkForAccount(alice);
  const bobSdk = buildSdkForAccount(bob);
  const holderSdk = buildSdkForAccount(holder);

  // --- Phase 0: fund underlying mUSD (deployer is the open-faucet minter) ----------------
  const deployer = new Wallet(env.deployerPrivateKey, provider);
  const mockUsdAsDeployer = new Contract(env.mockUsdAddress, MOCK_USD_ABI, deployer);
  const mockUsd = new Contract(env.mockUsdAddress, MOCK_USD_ABI, provider);

  await (await mockUsdAsDeployer.mint(alice.address, funding.alice)).wait();
  log("fund", `mint ${fmt(funding.alice)} mUSD -> ${alice.label}`);
  await (await mockUsdAsDeployer.mint(bob.address, funding.bob)).wait();
  log("fund", `mint ${fmt(funding.bob)} mUSD -> ${bob.label}`);

  // --- Phase 1: shields ------------------------------------------------------------------
  for (let i = 1; i <= counts.aliceShields; i++) {
    const { txHash } = await aliceSdk.token.shield(ALICE_SHIELD);
    log("shield", `${alice.label}  ${fmt(ALICE_SHIELD)} mUSD -> cUSD  (${i}/${counts.aliceShields})  ${short(txHash)}`);
  }
  for (let i = 1; i <= counts.bobShields; i++) {
    const { txHash } = await bobSdk.token.shield(BOB_SHIELD);
    log("shield", `${bob.label}  ${fmt(BOB_SHIELD)} mUSD -> cUSD  (${i}/${counts.bobShields})  ${short(txHash)}`);
  }

  // --- Phase 2: confidential transfers ---------------------------------------------------
  await spend(aliceSdk, bob, SPEND, counts.aliceSpendsToBob);
  await spend(aliceSdk, holder, SPEND, counts.aliceSpendsToHolder);
  await spend(bobSdk, holder, SPEND, counts.bobSpendsToHolder);
  await spend(bobSdk, alice, SPEND, counts.bobSpendsToAlice);

  // --- Phase 3: unshields ----------------------------------------------------------------
  await unshield(aliceSdk, mockUsd, UNSHIELD, counts.aliceUnshields);
  await unshield(bobSdk, mockUsd, UNSHIELD, counts.bobUnshields);

  // --- Phase 4: verify final confidential balances (exercises the decrypt path) ----------
  console.log("\nFinal confidential balances (decrypted via SDK):");
  for (const a of [aliceSdk, bobSdk, holderSdk]) {
    try {
      const bal = await a.token.balanceOf(a.account.address);
      console.log(`  ${a.account.label.padEnd(26)} ${fmt(bal)} cUSD`);
    } catch (err) {
      console.log(`  ${a.account.label.padEnd(26)} <decrypt failed: ${(err as Error).message}>`);
    }
  }

  const totals = {
    shields: counts.aliceShields + counts.bobShields,
    transfers:
      counts.aliceSpendsToBob +
      counts.aliceSpendsToHolder +
      counts.bobSpendsToHolder +
      counts.bobSpendsToAlice,
    unshields: counts.aliceUnshields + counts.bobUnshields,
  };
  console.log(
    `\nDone. Emitted ${totals.shields} shields, ${totals.transfers} confidential transfers, ${totals.unshields} unshields.`,
  );
}

main()
  .then(() => {
    disposeRelayer();
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nPopulate failed:", err);
    disposeRelayer();
    process.exit(1);
  });
