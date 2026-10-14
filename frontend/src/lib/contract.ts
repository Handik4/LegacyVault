// EIP-1193 + genlayer-js integration for the LegacyVault contract.
//
//  * Reads use an account-less client and are bounded by a 6s AbortController.
//  * Writes: estimateTransactionFeesForWrite() -> writeContract({ fees }) ->
//    waitForTransactionReceipt() -> assessReceipt(). Nothing is hardcoded: no gas
//    limit, no fee value. If the estimate is unavailable the write is refused
//    rather than sent with a zero deposit.
//  * Every error is typed so the UI can tell "network syncing" from "contract
//    rejected" from "validators disagreed".

import { assessReceipt, ReceiptRejected } from "./receipt";

export const NETWORK = {
  name: "GenLayer Studio Next",
  chainId: 61997,
  chainIdHex: "0xf22d",
  rpcUrl: process.env.NEXT_PUBLIC_GENLAYER_RPC_URL ?? "https://studio-next.genlayer.com/api",
  explorerUrl: "https://explorer-studio-next.genlayer.com",
} as const;

export const CONTRACT_ADDRESS: string =
  process.env.NEXT_PUBLIC_LEGACYVAULT_ADDRESS ?? "0xaeE92c13Cd48F77D43992A957634DECf637A2dFf";

export const READ_TIMEOUT_MS = 6_000;

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: any[]) => void): void;
  removeListener?(event: string, handler: (...args: any[]) => void): void;
}

export function injectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;
}

// ---- errors ----------------------------------------------------------------
export class ReadTimeoutError extends Error {
  constructor(ms: number) {
    super(`Read exceeded ${ms / 1000}s and was aborted.`);
    this.name = "ReadTimeoutError";
  }
}
/** The RPC/read path failed (network, timeout, server-side fault). */
export class RpcSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcSyncError";
  }
}
export class FeeEstimationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeeEstimationError";
  }
}
export class WalletRejected extends Error {
  constructor() {
    super("Signature request was declined in the wallet.");
    this.name = "WalletRejected";
  }
}

// ---- bounded reads ----------------------------------------------------------
/**
 * Runs `run` under an AbortController that fires after `ms` (or when the
 * caller's `external` signal fires). The SDK read itself is not cancellable, so
 * the race abandons it: its eventual result is ignored.
 */
export async function readWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number = READ_TIMEOUT_MS,
  external?: AbortSignal,
): Promise<T> {
  const ac = new AbortController();
  const onExternal = () => ac.abort(new DOMException("Superseded", "AbortError"));
  if (external?.aborted) throw new DOMException("Superseded", "AbortError");
  external?.addEventListener("abort", onExternal);
  const timer = setTimeout(() => ac.abort(new ReadTimeoutError(ms)), ms);
  try {
    return await Promise.race([
      run(ac.signal),
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener("abort", () => reject(ac.signal.reason ?? new ReadTimeoutError(ms)));
      }),
    ]);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternal);
  }
}

// ---- serialized loading -------------------------------------------------------
/**
 * Runs an async read at most once at a time.
 *
 *  - `poll()`    is the background tick. While a read is in flight it does
 *                nothing: no abort, no stacked request. (The previous design made
 *                the tick an effect dependency, so every tick aborted an
 *                in-flight full-history read and restarted it; any read slower
 *                than the interval therefore never completed.)
 *  - `refresh()` is an explicit request (e.g. after a transaction). While a read
 *                is in flight it is coalesced into exactly ONE follow-up read, so
 *                the post-transaction state is never skipped and never doubled.
 *  - `dispose()` aborts the in-flight read; used on unmount only.
 *
 * `run` owns its own error handling; anything it throws is swallowed here so a
 * failed read can never wedge the lock.
 */
export class SerialLoader {
  private inFlight = false;
  private queued = false;
  private disposed = false;
  private ac: AbortController | null = null;

  constructor(private readonly run: (signal: AbortSignal) => Promise<void>) {}

  get isFetching(): boolean {
    return this.inFlight;
  }

  poll(): boolean {
    if (this.disposed || this.inFlight) return false;
    void this.start();
    return true;
  }

  refresh(): void {
    if (this.disposed) return;
    if (this.inFlight) {
      this.queued = true;
      return;
    }
    void this.start();
  }

  dispose(): void {
    this.disposed = true;
    this.queued = false;
    this.ac?.abort();
  }

  private async start(): Promise<void> {
    this.inFlight = true;
    const ac = new AbortController();
    this.ac = ac;
    try {
      await this.run(ac.signal);
    } catch {
      /* run() reports its own failures */
    } finally {
      this.inFlight = false;
      this.ac = null;
      if (this.queued && !this.disposed) {
        this.queued = false;
        void this.start();
      }
    }
  }
}

// ---- SDK loading ------------------------------------------------------------
interface SdkModule {
  createClient: (cfg: unknown) => any;
  chains?: Record<string, any>;
}

let sdkPromise: Promise<SdkModule> | null = null;
function loadSdk(): Promise<SdkModule> {
  if (!sdkPromise) {
    sdkPromise = (import("genlayer-js") as unknown as Promise<SdkModule>).catch((e) => {
      sdkPromise = null;
      throw new RpcSyncError(`GenLayer SDK failed to load: ${String(e?.message ?? e)}`);
    });
  }
  return sdkPromise;
}

// genlayer-js reads consensus fields off the chain object when dispatching a
// write, so the SDK's own definition is spread and only the RPC is overridden.
function buildChain(sdk: SdkModule): unknown {
  const shipped = sdk.chains?.studioDevnet;
  if (!shipped) throw new RpcSyncError("GenLayer SDK ships no chain definition for chain 61997.");
  return { ...shipped, rpcUrls: { default: { http: [NETWORK.rpcUrl] } } };
}

let readerPromise: Promise<any> | null = null;
function reader(): Promise<any> {
  if (!readerPromise) {
    readerPromise = loadSdk()
      .then((sdk) => sdk.createClient({ chain: buildChain(sdk) }))
      .catch((e) => {
        readerPromise = null;
        throw e;
      });
  }
  return readerPromise;
}

// ---- value normalisation ------------------------------------------------------
/** Calldata dicts decode to Map / bigint; JSON-shape them (bigint -> string). */
export function plain(v: unknown): any {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), plain(x)]));
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "bigint") return v.toString();
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

export async function readView<T = any>(
  functionName: string,
  args: unknown[] = [],
  external?: AbortSignal,
): Promise<T> {
  try {
    return await readWithTimeout(async () => {
      const client = await reader();
      const raw = await client.readContract({ address: CONTRACT_ADDRESS, functionName, args });
      return plain(raw) as T;
    }, READ_TIMEOUT_MS, external);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    if (e instanceof RpcSyncError || e instanceof ReadTimeoutError) throw e;
    throw new RpcSyncError(String((e as Error)?.message ?? e).split("\n")[0].slice(0, 240));
  }
}

// ---- writes -------------------------------------------------------------------
export type WritePhase = "estimating" | "signing" | "confirming";

export interface WriteRequest {
  account: string;
  provider: Eip1193Provider;
  functionName: string;
  args: unknown[];
  value?: bigint;
  onPhase?: (p: WritePhase) => void;
  /** Result is discarded (throws AbortError) if this fires before completion. */
  signal?: AbortSignal;
}

export interface WriteResult {
  hash: string;
  status: string;
  consensus: string;
  returnValue: string | null;
}

function leaderReturn(receipt: any): string | null {
  const readable = receipt?.consensus_data?.leader_receipt?.[0]?.result?.payload?.readable;
  if (typeof readable !== "string") return null;
  // calldata readable form wraps strings in quotes
  return readable.replace(/^"(.*)"$/, "$1");
}

function isUserRejection(e: any): boolean {
  const code = e?.code ?? e?.cause?.code;
  const msg = String(e?.message ?? "").toLowerCase();
  return code === 4001 || code === "ACTION_REJECTED" || msg.includes("user rejected") || msg.includes("user denied");
}

export async function writeVault(req: WriteRequest): Promise<WriteResult> {
  const sdk = await loadSdk();
  const chain = buildChain(sdk);
  const client = sdk.createClient({ chain, account: req.account, provider: req.provider });
  const throwIfStale = () => {
    if (req.signal?.aborted) throw new DOMException("Superseded", "AbortError");
  };

  req.onPhase?.("estimating");
  let fees: unknown;
  try {
    fees = await client.estimateTransactionFeesForWrite({
      account: req.account,
      address: CONTRACT_ADDRESS,
      functionName: req.functionName,
      args: req.args,
      value: req.value,
    });
  } catch (e) {
    throwIfStale();
    throw new FeeEstimationError(
      "Studio Next could not quote a fee for this call right now, so nothing was sent. " +
        `Try again shortly. (${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 160)})`,
    );
  }
  throwIfStale();

  req.onPhase?.("signing");
  let hash: string;
  try {
    hash = await client.writeContract({
      account: req.account,
      address: CONTRACT_ADDRESS,
      functionName: req.functionName,
      args: req.args,
      value: req.value,
      fees,
    });
  } catch (e) {
    throwIfStale();
    if (isUserRejection(e)) throw new WalletRejected();
    throw e;
  }
  throwIfStale();

  req.onPhase?.("confirming");
  const receipt = await client.waitForTransactionReceipt({
    hash,
    waitUntil: "decided",
    retries: 120,
    interval: 3000,
  });
  throwIfStale();

  const verdict = assessReceipt(receipt);
  if (!verdict.ok) throw new ReceiptRejected(verdict.failure, verdict.message, hash);
  return { hash, status: verdict.status, consensus: verdict.consensus, returnValue: leaderReturn(receipt) };
}

export function describeError(e: unknown): string {
  if (e instanceof ReceiptRejected) return e.message;
  if (e instanceof WalletRejected) return e.message;
  if (e instanceof FeeEstimationError) return e.message;
  if (e instanceof RpcSyncError || e instanceof ReadTimeoutError) return e.message;
  const msg = String((e as Error)?.message ?? e).split("\n")[0];
  const m = /ERR_[A-Z_]+/.exec(msg);
  return m ? `${m[0]}: ${msg.replace(/^.*?ERR_[A-Z_]+\s*/, "").slice(0, 160)}`.trim() : msg.slice(0, 240);
}

export const explorerTx = (hash: string) => `${NETWORK.explorerUrl}/tx/${hash}`;
export const explorerAddress = (a: string) => `${NETWORK.explorerUrl}/address/${a}`;
