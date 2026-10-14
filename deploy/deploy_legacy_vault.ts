/**
 * Deployment script for contracts/legacy_vault.py (GenLayer Studio Next, chain 61997).
 *
 *   genlayer deploy --rpc https://studio-next.genlayer.com/api
 *
 * `genlayer deploy` runs this file with a client already bound to the active
 * account, so the script never holds a key. Steps:
 *
 *   1. Fee deposit is DERIVED from the live fee policy
 *      (`estimateTransactionFees` / `estimateTransactionFeesForWrite`); no gas
 *      or fee constant is hardcoded here.
 *   2. Deploy with the three genesis registry base URLs as constructor args.
 *   3. STRICT receipt check -- a decided transaction is not a successful one.
 *      Required: ACCEPTED/FINALIZED + MAJORITY_AGREE + FINISHED_WITH_RETURN.
 *   4. Seed one demo vault (skip with LEGACYVAULT_SEED=0) and verify it by
 *      reading it back and comparing every committed field.
 *   5. Write deployments/studio-next.json.
 *
 * Environment (all optional):
 *   LEGACYVAULT_REGISTRY_A / _B / _C   genesis registry base URLs
 *   LEGACYVAULT_DEPLOY_TX              adopt an already-submitted deploy tx instead
 *                                      of deploying again (resume after a failed
 *                                      post-deploy step)
 *   LEGACYVAULT_SEED                   "0" to skip the demo vault
 *   LEGACYVAULT_SEED_DEPOSIT_WEI       demo deposit, default 10^16 (0.01 GEN)
 *
 * Types are structural: the CLI resolves genlayer-js from its own install and
 * this file has no runtime dependency of its own.
 */

import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const CONTRACT_PATH = "contracts/legacy_vault.py";
const RPC_URL = "https://studio-next.genlayer.com/api";
const EXPLORER = "https://explorer-studio-next.genlayer.com";
const CHAIN_ID = 61997;
const RETRIES = 200;

// Genesis registries: three INDEPENDENT hosts (the contract rejects duplicate
// hosts) that mirror vital-record JSON for the testnet simulation. They resolve
// once this repository is pushed to GitHub; the governor can rotate any of them
// through the 7-day timelock.
const DEFAULT_REGISTRIES = [
  "https://raw.githubusercontent.com/Handik4/LegacyVault/main/deployments/mock_registry/a",
  "https://cdn.jsdelivr.net/gh/Handik4/LegacyVault@main/deployments/mock_registry/b",
  "https://rawcdn.githack.com/Handik4/LegacyVault/main/deployments/mock_registry/c",
];

// Demo identity. Fictional: the commitment is the only thing that goes on-chain.
const DEMO_IDENTITY = "demo testator|1970-01-01|DEMO";
// Two throwaway beneficiary addresses (no known private key).
const DEMO_HEIRS = [
  "0x00000000000000000000000000000000000d3a01",
  "0x00000000000000000000000000000000000d3a02",
];
const DEMO_SHARES = [7000, 3000];
const DEMO_NOTES = ["demo://ciphertext/shard-1", "demo://ciphertext/shard-2"];

interface Receipt {
  status?: number | string;
  statusName?: string;
  status_name?: string;
  resultName?: string;
  result_name?: string;
  txExecutionResultName?: string;
  data?: { contract_address?: string };
  txDataDecoded?: { contractAddress?: string };
  [k: string]: unknown;
}

interface Fees {
  distribution: Record<string, unknown>;
  messageAllocations?: unknown;
  feeValue: bigint;
}

interface DeployClient {
  initializeConsensusSmartContract(): Promise<void>;
  estimateTransactionFees(input: Record<string, never>): Promise<Fees>;
  estimateTransactionFeesForWrite(input: {
    address: string;
    functionName: string;
    args: unknown[];
    value?: bigint;
  }): Promise<Fees>;
  deployContract(input: { code: Uint8Array; args: unknown[]; fees?: Fees }): Promise<string>;
  writeContract(input: {
    address: string;
    functionName: string;
    args: unknown[];
    value?: bigint;
    fees?: Fees;
  }): Promise<string>;
  readContract(input: { address: string; functionName: string; args: unknown[] }): Promise<unknown>;
  waitForTransactionReceipt(input: {
    hash: string;
    waitUntil: "decided" | "finalized";
    retries: number;
  }): Promise<Receipt>;
}

/**
 * Strict acceptance: all three conditions, none optional. Studio Next returns
 * the lifecycle names snake_cased (`status_name`, `result_name`); the SDK's
 * typings spell them camelCase. Both are read, neither is assumed.
 */
export function assessReceipt(r: Receipt): { ok: boolean; reason: string } {
  const numeric = Number(r.status);
  const statusName = r.statusName ?? r.status_name;
  const resultName = r.resultName ?? r.result_name;
  const accepted =
    statusName === "ACCEPTED" || statusName === "FINALIZED" || numeric === 5 || numeric === 7;
  if (!accepted) return { ok: false, reason: `status ${statusName ?? r.status} is not ACCEPTED/FINALIZED` };
  if (resultName !== "MAJORITY_AGREE")
    return { ok: false, reason: `consensus ${resultName ?? "<missing>"} is not MAJORITY_AGREE` };
  if (r.txExecutionResultName !== "FINISHED_WITH_RETURN")
    return {
      ok: false,
      reason: `execution ${r.txExecutionResultName ?? "<missing>"} is not FINISHED_WITH_RETURN`,
    };
  return { ok: true, reason: "ACCEPTED/FINALIZED + MAJORITY_AGREE + FINISHED_WITH_RETURN" };
}

function addressFrom(r: Receipt): string | undefined {
  return (
    r.txDataDecoded?.contractAddress ??
    r.data?.contract_address ??
    ((r.contractAddress ?? r.contract_address) as string | undefined)
  );
}

/** calldata dicts may decode to a Map or a plain object. */
function plain(v: unknown): any {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]));
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "bigint") return v.toString();
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, plain(x)]));
  return v;
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Studio Next's `gen_call` backend can fail server-side ("Can't reconnect until
 * invalid transaction is rolled back") independently of any contract. Retry,
 * then report -- the caller records exactly which checks could not be done
 * instead of pretending they passed.
 */
async function attempt<T>(fn: () => Promise<T>, tries = 5, waitMs = 8000): Promise<Attempt<T>> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      last = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200);
      if (i < tries - 1) await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return { ok: false, error: last };
}

/** Independent of gen_call: hash the source the deploy tx carried. */
async function explorerSourceSha256(address: string): Promise<string | null> {
  try {
    const res = await fetch(`${EXPLORER}/api/address/${address}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { transactions?: { data?: { contract_code?: string } }[] };
    const code = body.transactions?.[0]?.data?.contract_code;
    if (!code) return null;
    return createHash("sha256").update(Buffer.from(code, "base64")).digest("hex");
  } catch {
    return null;
  }
}

/** The write's decoded return value, from the leader's receipt. */
function leaderReturn(r: Receipt): string | null {
  const cd = r.consensus_data as { leader_receipt?: any[] } | undefined;
  const readable = cd?.leader_receipt?.[0]?.result?.payload?.readable;
  return typeof readable === "string" ? readable : null;
}

function mustBeStrict(label: string, r: Receipt): void {
  const verdict = assessReceipt(r);
  if (!verdict.ok) throw new Error(`${label} rejected by strict receipt check: ${verdict.reason}`);
  console.log(`  ${label}: ${verdict.reason}`);
}

export default async function main(client: DeployClient): Promise<string> {
  const filePath = path.resolve(process.cwd(), CONTRACT_PATH);
  const sourceBytes = readFileSync(filePath);
  const code = new Uint8Array(sourceBytes);
  const registries = [
    process.env.LEGACYVAULT_REGISTRY_A ?? DEFAULT_REGISTRIES[0],
    process.env.LEGACYVAULT_REGISTRY_B ?? DEFAULT_REGISTRIES[1],
    process.env.LEGACYVAULT_REGISTRY_C ?? DEFAULT_REGISTRIES[2],
  ];

  await client.initializeConsensusSmartContract();

  // 1+2. Deploy (or adopt an already-submitted deploy tx). The deposit comes
  // from the chain's live fee policy.
  let deployHash = process.env.LEGACYVAULT_DEPLOY_TX ?? "";
  if (deployHash === "") {
    const deployFees = await client.estimateTransactionFees({});
    deployHash = await client.deployContract({ code, args: registries, fees: deployFees });
    console.log(`deploy tx ${deployHash}`);
  } else {
    console.log(`adopting deploy tx ${deployHash}`);
  }
  const deployReceipt = await client.waitForTransactionReceipt({
    hash: deployHash,
    waitUntil: "decided",
    retries: RETRIES,
  });
  mustBeStrict("deploy", deployReceipt);
  const address = addressFrom(deployReceipt);
  if (!address) throw new Error(`deploy receipt carried no contract address: ${JSON.stringify(deployReceipt)}`);
  console.log(`LegacyVault deployed at ${address}`);

  // Verification 1 (independent of gen_call): the deployed bytes are our file.
  const localSha = createHash("sha256").update(sourceBytes).digest("hex");
  const remoteSha = await explorerSourceSha256(address);
  if (remoteSha !== null && remoteSha !== localSha)
    throw new Error(`deployed source ${remoteSha} != local ${localSha}`);
  const verification: Record<string, string> = {
    source_hash: remoteSha === null ? "unavailable (explorer unreachable)" : "match",
  };
  console.log(`  source hash: ${verification.source_hash}`);

  // Verification 2: the constructor stored exactly the registries we sent.
  const overviewTry = await attempt(async () =>
    plain(await client.readContract({ address, functionName: "get_protocol_overview", args: [] })),
  );
  if (overviewTry.ok) {
    const onChain = (overviewTry.value.registries as { base_url: string }[]).map((r) => r.base_url);
    if (JSON.stringify(onChain) !== JSON.stringify(registries))
      throw new Error(`registry mismatch: sent ${JSON.stringify(registries)} got ${JSON.stringify(onChain)}`);
    verification.registries = "match (state read)";
  } else {
    verification.registries = `NOT VERIFIED: gen_call unavailable (${overviewTry.error})`;
  }
  console.log(`  registries: ${verification.registries}`);

  // 4. Seed + verify one demo vault.
  let seed: Record<string, unknown> | null = null;
  if (process.env.LEGACYVAULT_SEED !== "0") {
    const deposit = BigInt(process.env.LEGACYVAULT_SEED_DEPOSIT_WEI ?? "10000000000000000");
    const commitment = createHash("sha256").update(DEMO_IDENTITY).digest("hex");
    const args = [commitment, 90, DEMO_HEIRS, DEMO_SHARES, DEMO_NOTES, ""];
    // Fee deposit from the live policy. With no quote there is nothing honest
    // to attach (the chain rejects a zero deposit), so the seed is SKIPPED and
    // recorded as such rather than sent to revert. Re-run with
    // LEGACYVAULT_DEPLOY_TX=<hash> once the fee endpoint answers.
    const feeTry = await attempt(
      () => client.estimateTransactionFeesForWrite({ address, functionName: "create_vault", args, value: deposit }),
      3,
    );
    if (!feeTry.ok) {
      verification.seed_state = `SKIPPED: fee quote unavailable (${feeTry.error})`;
      console.log(`  seed: ${verification.seed_state}`);
    }
    const seedHash = feeTry.ok
      ? await client.writeContract({ address, functionName: "create_vault", args, value: deposit, fees: feeTry.value })
      : "";
    if (feeTry.ok) {
    console.log(`seed tx ${seedHash}`);
    const seedReceipt = await client.waitForTransactionReceipt({
      hash: seedHash,
      waitUntil: "decided",
      retries: RETRIES,
    });
    mustBeStrict("seed create_vault", seedReceipt);

    // create_vault returns the new vault id; the first vault must be #1.
    const ret = leaderReturn(seedReceipt);
    if (ret !== "1") throw new Error(`seed create_vault returned ${ret ?? "<none>"}, expected 1`);
    verification.seed_return_value = "1 (from leader receipt)";

    const vaultTry = await attempt(async () =>
      plain(await client.readContract({ address, functionName: "get_vault", args: [1] })),
    );
    if (vaultTry.ok) {
      const vault = vaultTry.value;
      const heirs = (vault.beneficiaries as { address: string; bps: number | string }[]).map((b) => ({
        a: b.address.toLowerCase(),
        b: Number(b.bps),
      }));
      const expectHeirs = DEMO_HEIRS.map((a, i) => ({ a, b: DEMO_SHARES[i] }));
      const checks: [string, boolean][] = [
        ["identity_commitment", vault.identity_commitment === commitment],
        ["principal", String(vault.principal) === deposit.toString()],
        ["state ACTIVE", vault.state_name === "ACTIVE"],
        ["threshold 90d", Number(vault.inactivity_threshold) === 90 * 86400],
        ["beneficiaries", JSON.stringify(heirs) === JSON.stringify(expectHeirs)],
      ];
      const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
      if (failed.length) throw new Error(`seed verification failed: ${failed.join(", ")}`);
      verification.seed_state = "match (field-by-field state read)";
    } else {
      verification.seed_state = `NOT VERIFIED: gen_call unavailable (${vaultTry.error})`;
    }
    console.log(`  seed state: ${verification.seed_state}`);
    seed = { vault_id: 1, tx: seedHash, identity_commitment: commitment, principal_wei: deposit.toString() };
    }
  }

  // 5. Record.
  const record = {
    network: "studio-next",
    chain_id: CHAIN_ID,
    rpc_url: RPC_URL,
    contract_address: address,
    explorer_url: `${EXPLORER}/address/${address}`,
    source: CONTRACT_PATH,
    source_sha256: localSha,
    verification,
    deploy_tx: deployHash,
    deploy_receipt_check: assessReceipt(deployReceipt).reason,
    genesis_registries: registries,
    seed,
    recorded_at: new Date().toISOString(),
  };
  mkdirSync(path.resolve(process.cwd(), "deployments"), { recursive: true });
  writeFileSync(
    path.resolve(process.cwd(), "deployments/studio-next.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log("wrote deployments/studio-next.json");
  console.log(`Set NEXT_PUBLIC_LEGACYVAULT_ADDRESS=${address} in frontend/.env.local`);
  return address;
}
