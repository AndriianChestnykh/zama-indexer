// Wiring for the Zama high-level SDK (alpha) against the local forge-fhevm *cleartext* stack.
//
// On this stack FHE values are stored as on-chain plaintexts (nothing is really encrypted). The SDK's
// cleartext relayer reads those plaintexts directly from the FHEVMExecutor and synthesises the
// input/decryption proofs locally using the canonical local-stack signer keys — so there is NO
// off-chain relayer/KMS to run and NO WASM worker threads.
//
// SDK v3.1 alpha is config-driven: `createConfig` (the ethers adapter) takes the FHE chain(s), a
// per-chain relayer factory, the signer, and storage; `cleartext()` selects the cleartext relayer and
// `hardhat` is the built-in chainId-31337 preset (ACL / executor / verifier addresses matching what
// forge-fhevm materialises and our repo-root .env). We only override `network` so it honours RPC_URL.
import { JsonRpcProvider, Wallet } from "ethers";
import { MemoryStorage, ZamaSDK, cleartext, type WrappedToken } from "@zama-fhe/sdk";
import { hardhat } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/ethers";
import { env } from "./config.js";
import type { Account } from "./accounts.js";

// One JSON-RPC provider shared by every wallet.
// `cacheTimeout: -1` disables ethers' ~250ms RPC response cache. Against Anvil's instant mining,
// sequential txs from one signer resolve faster than that window, so a cached `eth_getTransactionCount`
// would hand two txs the same nonce ("nonce too low").
export const provider = new JsonRpcProvider(env.rpcUrl, undefined, { cacheTimeout: -1 });

// The local cleartext fhEVM chain, pointed at our RPC.
const localChain = { ...hardhat, network: env.rpcUrl };

export interface AccountSdk {
  account: Account;
  wallet: Wallet;
  sdk: ZamaSDK;
  /** ConfidentialUSD (an ERC-7984 wrapper) bound to this account's signer; has shield/unshield. */
  token: WrappedToken;
}

/** Build an SDK + Token interface for one account, signing with its private key. */
export function buildSdkForAccount(account: Account): AccountSdk {
  const wallet = new Wallet(account.privateKey, provider);
  const config = createConfig({
    chains: [localChain],
    relayers: { 31337: cleartext() }, // 31337 == hardhat.id
    signer: wallet,
    storage: new MemoryStorage(),
  });
  const sdk = new ZamaSDK(config);
  const token = sdk.createWrappedToken(env.confidentialUsdAddress);
  return { account, wallet, sdk, token };
}

/**
 * Release relayer resources so the process can exit cleanly. In cleartext mode each SDK's relayer has
 * no worker threads to tear down (that is the node/web relayer path), so this is a no-op kept for a
 * stable interface; the populate script `process.exit(0)`s regardless.
 */
export function disposeRelayer(): void {
  // no-op for the cleartext relayer
}
