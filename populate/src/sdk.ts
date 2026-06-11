// Wiring for the Zama high-level SDK against the local forge-fhevm *cleartext* stack.
//
// On this stack FHE values are stored as on-chain plaintexts (nothing is really
// encrypted). The SDK's `RelayerCleartext` transport reads those plaintexts directly
// from the FHEVMExecutor and synthesises the input/decryption proofs locally using the
// canonical local-stack signer keys — so there is NO off-chain relayer/KMS to run and
// NO WASM worker threads (that is the `RelayerNode` path, which we deliberately avoid).
//
// `hardhatCleartextConfig` is the SDK's built-in preset for chainId 31337; its ACL /
// executor / verifier addresses match the ones forge-fhevm materialises (and the ones
// in our repo-root .env). We only override `network` so it honours RPC_URL.
import { JsonRpcProvider, Wallet } from "ethers";
import { MemoryStorage, ZamaSDK, type Token } from "@zama-fhe/sdk";
import { EthersSigner } from "@zama-fhe/sdk/ethers";
import { RelayerCleartext, hardhatCleartextConfig } from "@zama-fhe/sdk/cleartext";
import { env } from "./config.js";
import type { Account } from "./accounts.js";

// One JSON-RPC provider shared by every wallet.
// `cacheTimeout: -1` disables ethers' ~250ms RPC response cache. Against Anvil's instant
// mining, sequential txs from one signer resolve faster than that window, so a cached
// `eth_getTransactionCount` would hand two txs the same nonce ("nonce too low").
export const provider = new JsonRpcProvider(env.rpcUrl, undefined, { cacheTimeout: -1 });

/**
 * One cleartext relayer shared by every SDK instance. The relayer is account-agnostic;
 * only the signer differs per account.
 */
const relayer = new RelayerCleartext({
  ...hardhatCleartextConfig,
  network: env.rpcUrl,
});

export interface AccountSdk {
  account: Account;
  wallet: Wallet;
  sdk: ZamaSDK;
  /** ConfidentialUSD bound to this account's signer (wrapper == token address). */
  token: Token;
}

/** Build an SDK + Token interface for one account, signing with its private key. */
export function buildSdkForAccount(account: Account): AccountSdk {
  const wallet = new Wallet(account.privateKey, provider);
  const sdk = new ZamaSDK({
    relayer,
    signer: new EthersSigner({ signer: wallet }),
    storage: new MemoryStorage(),
  });
  const token = sdk.createToken(env.confidentialUsdAddress);
  return { account, wallet, sdk, token };
}

/** Release worker/relayer resources so the process can exit cleanly. */
export function disposeRelayer(): void {
  relayer.terminate();
}
