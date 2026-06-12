// Delegate ERC-7984 user-decryption rights to the indexer holder, via the fhEVM ACL.
//
// Demo flow this enables (each step independent):
//   1. `make populate`  — seed the token with events
//   2. query the API    — some amounts are `amountStatus: "unauthorized"`, balances `encrypted: true`
//   3. `make grant`      — a delegator (Alice by default) runs THIS script
//   4. re-query the API  — those handles flip to `decrypted`, live, via the indexer's backfill
//
// On-chain, `ACL.delegateForUserDecryption(delegate, contractAddress, expirationDate)` is sent BY the
// delegator (msg.sender). After it lands, the indexer (delegate = holder) can `delegatedUserDecrypt`
// every handle the delegator was allowed on — exactly the amounts it could not read before. The grant
// emits `DelegatedForUserDecryption`, which the indexer's ACL handler turns into a backfill sweep.
//
// Usage:
//   npm run grant                 # Alice grants to the indexer holder (default)
//   npm run grant -- bob          # Bob grants
//   npm run grant -- 0x<privkey>  # any address grants (its private key signs)
//   npm run grant -- alice --days=30
import { Contract, JsonRpcProvider, Wallet, isError } from "ethers";
import { LOCAL_CHAIN_ID, env } from "./config.js";

type Hex = `0x${string}`;

// Minimal ACL ABI: the one function we call, the event we want to read back, and the custom errors
// we want decoded so failures are legible. (The SDK's `delegateForUserDecryptionContract` helper
// produces the same function ABI/args — this hand-written fragment keeps the tool dependency-light.)
const ACL_ABI = [
  "function delegateForUserDecryption(address delegate, address contractAddress, uint64 expirationDate)",
  "event DelegatedForUserDecryption(address indexed delegator, address indexed delegate, address contractAddress, uint64 delegationCounter, uint64 oldExpirationDate, uint64 newExpirationDate)",
  "error AlreadyDelegatedOrRevokedInSameBlock(address sender, address delegate, address contractAddress, uint256 blockNumber)",
  "error ExpirationDateAlreadySetToSameValue(address sender, address delegate, address contractAddress, uint64 expirationDate)",
  "error ExpirationDateInThePast()",
  "error SenderCannotBeDelegate(address delegate)",
  "error SenderCannotBeContractAddress(address contractAddress)",
  "error DelegateCannotBeContractAddress(address contractAddress)",
] as const;

const USAGE = "usage: npm run grant -- [alice|bob|0x<privkey>] [--days=<n>]";

interface Delegator {
  label: string;
  privateKey: Hex;
}

/** Resolve the granting account from the first positional CLI arg (default: alice). */
function resolveDelegator(positional: string | undefined): Delegator {
  const raw = positional ?? "alice";
  switch (raw.toLowerCase()) {
    case "alice":
      return { label: "alice", privateKey: env.alicePrivateKey };
    case "bob":
      return { label: "bob", privateKey: env.bobPrivateKey };
    default:
      if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return { label: "custom", privateKey: raw as Hex };
      throw new Error(`Unrecognized delegator "${raw}".\n${USAGE}`);
  }
}

function parseDays(args: string[]): number {
  const flag = args.find((a) => a.startsWith("--days="));
  const value = Number(flag ? flag.split("=")[1] : (process.env.DELEGATION_DAYS ?? "365"));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--days must be a positive integer (got ${value}).`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.find((a) => !a.startsWith("--"));
  const delegator = resolveDelegator(positional);
  const days = parseDays(args);

  const provider = new JsonRpcProvider(env.rpcUrl);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== LOCAL_CHAIN_ID) {
    throw new Error(
      `Expected the local stack (chainId ${LOCAL_CHAIN_ID}) but RPC ${env.rpcUrl} is chainId ${net.chainId}.`,
    );
  }

  const wallet = new Wallet(delegator.privateKey, provider);
  const granter = wallet.address;
  const delegate = env.holderAddress; // the indexer holder
  const contract = env.confidentialUsdAddress;

  // Local guards mirroring the ACL's own reverts, with friendlier messages.
  if (granter.toLowerCase() === delegate.toLowerCase()) {
    throw new Error("The delegator must differ from the delegate (the indexer holder cannot grant to itself).");
  }
  if (granter.toLowerCase() === contract.toLowerCase()) {
    throw new Error("The delegator must differ from the token contract address.");
  }

  // Expiration must be strictly in the future per chain time (not wall-clock).
  const latest = await provider.getBlock("latest");
  if (!latest) throw new Error("Could not read the latest block to compute an expiration.");
  const expiration = BigInt(latest.timestamp) + BigInt(days) * 86_400n;
  const expiresAt = new Date(Number(expiration) * 1000).toISOString();

  console.log(`\nDelegating user-decryption rights on ConfidentialUSD ${contract}`);
  console.log(`  delegator (${delegator.label}): ${granter}`);
  console.log(`  delegate  (indexer holder):    ${delegate}`);
  console.log(`  expires:                       ${expiresAt}  (chain ts ${expiration}, +${days}d)\n`);

  const acl = new Contract(env.aclAddress, ACL_ABI, wallet);
  const tx = await acl.delegateForUserDecryption(delegate, contract, expiration);
  console.log(`  submitted ${tx.hash} … waiting for receipt`);
  const receipt = await tx.wait();

  // Read back the emitted event for confirmation.
  let counter: bigint | undefined;
  for (const log of receipt?.logs ?? []) {
    if (log.address.toLowerCase() !== env.aclAddress.toLowerCase()) continue;
    try {
      const parsed = acl.interface.parseLog(log);
      if (parsed?.name === "DelegatedForUserDecryption") counter = parsed.args.delegationCounter as bigint;
    } catch {
      // not our event — ignore
    }
  }

  console.log(`  ✓ delegated in block ${receipt?.blockNumber}${counter !== undefined ? ` (delegation #${counter})` : ""}`);
  console.log(
    `\nThe indexer's DelegatedForUserDecryption handler will now backfill cleartext for handles\n` +
      `${granter} (${delegator.label}) is authorized on. Re-query the API to see the change:\n` +
      `  curl "localhost:42069/v1/addresses/${granter}/transactions?limit=100"\n` +
      `  curl "localhost:42069/v1/addresses/${granter}/balance"\n`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // Decode the two re-run-friendly ACL reverts; otherwise surface the raw error.
    if (isError(err, "CALL_EXCEPTION") && err.revert) {
      const name = err.revert.name;
      if (name === "ExpirationDateAlreadySetToSameValue" || name === "AlreadyDelegatedOrRevokedInSameBlock") {
        console.error(
          `\nGrant rejected (${name}): this delegation/expiration was already set in this block.\n` +
            `Re-run with a different duration, e.g. \`npm run grant -- ${process.argv[2] ?? "alice"} --days=30\`, or wait one block.\n`,
        );
        process.exit(1);
      }
      console.error(`\nGrant reverted: ${name}\n`);
      process.exit(1);
    }
    console.error("\nGrant failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
