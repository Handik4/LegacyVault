"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { injectedProvider, NETWORK, type Eip1193Provider } from "@/lib/contract";

const DISCONNECT_FLAG = "legacyvault:user-disconnected";

interface WalletState {
  /** Lower-cased connected address, or null. Panels are keyed by this value. */
  account: string | null;
  provider: Eip1193Provider | null;
  chainOk: boolean;
  connecting: boolean;
  hasWallet: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  switchChain: () => Promise<void>;
}

const Ctx = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<string | null>(null);
  const [chainOk, setChainOk] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasWallet, setHasWallet] = useState(false);
  const providerRef = useRef<Eip1193Provider | null>(null);

  const readChain = useCallback(async (p: Eip1193Provider) => {
    try {
      const id = (await p.request({ method: "eth_chainId" })) as string;
      setChainOk(id?.toLowerCase() === NETWORK.chainIdHex);
    } catch {
      setChainOk(false);
    }
  }, []);

  // Restore a previous session unless the user explicitly disconnected.
  useEffect(() => {
    const p = injectedProvider();
    providerRef.current = p;
    setHasWallet(p !== null);
    if (!p) return;
    let cancelled = false;
    if (localStorage.getItem(DISCONNECT_FLAG) !== "1") {
      p.request({ method: "eth_accounts" })
        .then((accs) => {
          const a = (accs as string[] | undefined)?.[0];
          if (!cancelled && a) {
            setAccount(a.toLowerCase());
            void readChain(p);
          }
        })
        .catch(() => undefined);
    }
    const onAccounts = (accs: string[]) => {
      // Switching accounts in the wallet changes `account` synchronously, which
      // re-keys every panel and drops its state and in-flight reads.
      if (localStorage.getItem(DISCONNECT_FLAG) === "1") return;
      setAccount(accs?.[0] ? accs[0].toLowerCase() : null);
    };
    const onChain = (id: string) => setChainOk(String(id).toLowerCase() === NETWORK.chainIdHex);
    p.on?.("accountsChanged", onAccounts);
    p.on?.("chainChanged", onChain);
    return () => {
      cancelled = true;
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [readChain]);

  const switchChain = useCallback(async () => {
    const p = providerRef.current;
    if (!p) return;
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: NETWORK.chainIdHex }] });
    } catch (e: any) {
      if (e?.code === 4902 || e?.code === -32603) {
        await p.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: NETWORK.chainIdHex,
              chainName: NETWORK.name,
              nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
              rpcUrls: [NETWORK.rpcUrl],
              blockExplorerUrls: [NETWORK.explorerUrl],
            },
          ],
        });
      } else {
        throw e;
      }
    }
    await readChain(p);
  }, [readChain]);

  const connect = useCallback(async () => {
    const p = providerRef.current ?? injectedProvider();
    if (!p) {
      setError("No EIP-1193 wallet detected. Install MetaMask to sign transactions.");
      return;
    }
    providerRef.current = p;
    setConnecting(true);
    setError(null);
    try {
      const accs = (await p.request({ method: "eth_requestAccounts" })) as string[];
      localStorage.removeItem(DISCONNECT_FLAG);
      setAccount(accs?.[0] ? accs[0].toLowerCase() : null);
      await readChain(p);
    } catch (e: any) {
      setError(e?.code === 4001 ? "Connection request was declined." : String(e?.message ?? e).slice(0, 200));
    } finally {
      setConnecting(false);
    }
  }, [readChain]);

  const disconnect = useCallback(async () => {
    localStorage.setItem(DISCONNECT_FLAG, "1");
    setAccount(null);
    setError(null);
    // Best effort: revoke the site's permission so the wallet forgets us too.
    try {
      await providerRef.current?.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      /* not supported by every wallet; local disconnect already applied */
    }
  }, []);

  const value = useMemo<WalletState>(
    () => ({
      account,
      provider: providerRef.current,
      chainOk,
      connecting,
      hasWallet,
      error,
      connect,
      disconnect,
      switchChain,
    }),
    [account, chainOk, connecting, hasWallet, error, connect, disconnect, switchChain],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
