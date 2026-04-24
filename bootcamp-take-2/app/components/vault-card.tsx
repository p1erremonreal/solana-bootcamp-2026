"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallet } from "../lib/wallet/context";
import { useSendTransaction } from "../lib/hooks/use-send-transaction";
import { useBalance } from "../lib/hooks/use-balance";
import { lamportsFromSol, lamportsToSolString } from "../lib/lamports";
import { useSolanaClient } from "../lib/solana-client-context";
import { address, type Address } from "@solana/kit";
import { toast } from "sonner";
import {
  getDepositSolInstructionAsync,
  getWithdrawSolInstructionAsync,
  getDepositSplInstructionAsync,
  getWithdrawSplInstructionAsync,
} from "../generated/vault";
import { parseTransactionError } from "../lib/errors";
import { useCluster } from "./cluster-context";

type Tab = "sol" | "spl";

export function VaultCard() {
  const { wallet, signer, status } = useWallet();
  const { send, isSending } = useSendTransaction();
  const { getExplorerUrl } = useCluster();
  const client = useSolanaClient();

  const [tab, setTab] = useState<Tab>("sol");

  // SOL state
  const [solDepositAmount, setSolDepositAmount] = useState("");
  const [solWithdrawAmount, setSolWithdrawAmount] = useState("");
  const [vaultAddress, setVaultAddress] = useState<Address | null>(null);

  // SPL state
  const [mintInput, setMintInput] = useState("");
  const [splAmount, setSplAmount] = useState("");
  const [splDecimals, setSplDecimals] = useState<number | null>(null);
  const [vaultSplBalance, setVaultSplBalance] = useState<string | null>(null);
  const [vaultAta, setVaultAta] = useState<Address | null>(null);

  const walletAddress = wallet?.account.address;

  // Derive vault PDA from generated IDL client
  useEffect(() => {
    let cancelled = false;
    async function deriveVault() {
      if (!signer) {
        setVaultAddress(null);
        return;
      }
      try {
        const ix = await getWithdrawSolInstructionAsync({ signer, amount: 0n });
        const pda = ix.accounts[1]?.address;
        if (!cancelled) setVaultAddress((pda as Address) ?? null);
      } catch {
        if (!cancelled) setVaultAddress(null);
      }
    }
    void deriveVault();
    return () => {
      cancelled = true;
    };
  }, [signer]);

  const walletBalance = useBalance(walletAddress);
  const walletLamports = walletBalance?.lamports;
  const vaultBalance = useBalance(vaultAddress ?? undefined);
  const vaultLamports = vaultBalance?.lamports;

  // Resolve mint decimals + derive vault ATA + fetch balance when mint input is valid
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setSplDecimals(null);
      setVaultSplBalance(null);
      setVaultAta(null);

      if (!signer || !mintInput) return;

      let mintAddr: Address;
      try {
        mintAddr = address(mintInput.trim());
      } catch {
        return;
      }

      try {
        const { value: mintInfo } = await client.rpc
          .getAccountInfo(mintAddr, { encoding: "jsonParsed" })
          .send();

        const parsed = (mintInfo?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed;
        const decimals = parsed?.info?.decimals;
        if (typeof decimals !== "number") return;
        if (cancelled) return;
        setSplDecimals(decimals);

        // Derive vault ATA by building an instruction and pulling the vault_token_account address
        const ix = await getDepositSplInstructionAsync({
          signer,
          mint: mintAddr,
          amount: 0n,
        });
        const vaultTokenAccount = ix.accounts[4]?.address as Address | undefined;
        if (!vaultTokenAccount || cancelled) return;
        setVaultAta(vaultTokenAccount);

        const { value } = await client.rpc
          .getTokenAccountBalance(vaultTokenAccount)
          .send()
          .catch(() => ({ value: null }));
        if (cancelled) return;
        setVaultSplBalance(value?.uiAmountString ?? "0");
      } catch {
        // ignore — user may still be typing
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [signer, mintInput, client, isSending]);

  const handleDepositSol = useCallback(async () => {
    if (!walletAddress || !solDepositAmount || !signer) return;
    const depositLamports = lamportsFromSol(parseFloat(solDepositAmount));
    if (walletLamports != null && walletLamports < depositLamports) {
      toast.error("Insufficient balance.", {
        description: `Current balance: ${lamportsToSolString(walletLamports)} SOL.`,
      });
      return;
    }

    try {
      const instruction = await getDepositSolInstructionAsync({
        signer,
        amount: depositLamports,
      });
      const signature = await send({ instructions: [instruction] });
      toast.success("Deposit confirmed!", {
        description: (
          <a
            href={getExplorerUrl(`/tx/${signature}`)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            View transaction
          </a>
        ),
      });
      setSolDepositAmount("");
    } catch (err) {
      console.error("Deposit SOL failed:", err);
      toast.error(parseTransactionError(err));
    }
  }, [walletAddress, solDepositAmount, walletLamports, signer, send, getExplorerUrl]);

  const handleWithdrawSol = useCallback(
    async (overrideAmount?: bigint) => {
      if (!signer) return;
      const amt = overrideAmount ?? lamportsFromSol(parseFloat(solWithdrawAmount || "0"));
      if (!amt || amt <= 0n) return;

      try {
        const instruction = await getWithdrawSolInstructionAsync({ signer, amount: amt });
        const signature = await send({ instructions: [instruction] });
        toast.success("Withdrawal confirmed!", {
          description: (
            <a
              href={getExplorerUrl(`/tx/${signature}`)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              View transaction
            </a>
          ),
        });
        setSolWithdrawAmount("");
      } catch (err) {
        console.error("Withdraw SOL failed:", err);
        toast.error(parseTransactionError(err));
      }
    },
    [solWithdrawAmount, signer, send, getExplorerUrl],
  );

  const handleSpl = useCallback(
    async (direction: "deposit" | "withdraw") => {
      if (!signer || !splAmount || splDecimals == null) return;
      let mintAddr: Address;
      try {
        mintAddr = address(mintInput.trim());
      } catch {
        toast.error("Invalid mint address.");
        return;
      }

      const parsed = parseFloat(splAmount);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      const rawAmount = BigInt(Math.round(parsed * 10 ** splDecimals));

      try {
        const instruction =
          direction === "deposit"
            ? await getDepositSplInstructionAsync({
                signer,
                mint: mintAddr,
                amount: rawAmount,
              })
            : await getWithdrawSplInstructionAsync({
                signer,
                mint: mintAddr,
                amount: rawAmount,
              });

        const signature = await send({ instructions: [instruction] });
        toast.success(`${direction === "deposit" ? "Deposit" : "Withdrawal"} confirmed!`, {
          description: (
            <a
              href={getExplorerUrl(`/tx/${signature}`)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              View transaction
            </a>
          ),
        });
        setSplAmount("");
      } catch (err) {
        console.error(`${direction} SPL failed:`, err);
        toast.error(parseTransactionError(err));
      }
    },
    [signer, mintInput, splAmount, splDecimals, send, getExplorerUrl],
  );

  if (status !== "connected") {
    return (
      <section className="w-full space-y-4 rounded-2xl border border-border-low bg-card p-6 shadow-[0_20px_80px_-50px_rgba(0,0,0,0.35)]">
        <div className="space-y-1">
          <p className="text-lg font-semibold">Vault</p>
          <p className="text-sm text-muted">
            Connect your wallet to interact with the vault program.
          </p>
        </div>
        <div className="rounded-lg bg-cream/50 p-4 text-center text-sm text-muted">
          Wallet not connected
        </div>
      </section>
    );
  }

  return (
    <section className="w-full space-y-4 rounded-2xl border border-border-low bg-card p-6 shadow-[0_20px_80px_-50px_rgba(0,0,0,0.35)]">
      <div className="space-y-1">
        <p className="text-lg font-semibold">Vault</p>
        <p className="text-sm text-muted">
          Deposit and withdraw SOL or SPL tokens from your personal vault PDA.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg bg-cream/40 p-1">
        <button
          onClick={() => setTab("sol")}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
            tab === "sol" ? "bg-card shadow-xs" : "text-muted hover:text-foreground"
          }`}
        >
          SOL
        </button>
        <button
          onClick={() => setTab("spl")}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
            tab === "spl" ? "bg-card shadow-xs" : "text-muted hover:text-foreground"
          }`}
        >
          SPL Token
        </button>
      </div>

      {tab === "sol" && (
        <div className="space-y-4">
          {/* SOL Vault Balance */}
          <div className="rounded-xl border border-border-low bg-cream/30 p-4">
            <p className="text-xs uppercase tracking-wide text-muted">Vault Balance</p>
            <p className="mt-1 text-3xl font-bold tabular-nums">
              {vaultLamports ? lamportsToSolString(vaultLamports) : "0"}{" "}
              <span className="text-lg font-normal text-muted">SOL</span>
            </p>
            {vaultAddress && (
              <a
                href={getExplorerUrl(`/address/${vaultAddress}`)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 block truncate font-mono text-xs text-muted underline underline-offset-2"
              >
                {vaultAddress}
              </a>
            )}
          </div>

          {/* Deposit */}
          <div className="flex gap-3">
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Amount in SOL"
              value={solDepositAmount}
              onChange={(e) => setSolDepositAmount(e.target.value)}
              disabled={isSending}
              className="flex-1 rounded-lg border border-border-low bg-card px-4 py-2.5 text-sm outline-none transition placeholder:text-muted focus:border-foreground/30 disabled:opacity-50 disabled:pointer-events-none"
            />
            <button
              onClick={handleDepositSol}
              disabled={isSending || !solDepositAmount || parseFloat(solDepositAmount) <= 0}
              className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-xs transition hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
            >
              {isSending ? "…" : "Deposit"}
            </button>
          </div>

          {/* Withdraw */}
          <div className="flex gap-3">
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Amount in SOL"
              value={solWithdrawAmount}
              onChange={(e) => setSolWithdrawAmount(e.target.value)}
              disabled={isSending}
              className="flex-1 rounded-lg border border-border-low bg-card px-4 py-2.5 text-sm outline-none transition placeholder:text-muted focus:border-foreground/30 disabled:opacity-50 disabled:pointer-events-none"
            />
            <button
              onClick={() => handleWithdrawSol()}
              disabled={isSending || !solWithdrawAmount || parseFloat(solWithdrawAmount) <= 0 || !vaultLamports}
              className="rounded-lg border border-border-low bg-card px-4 py-2.5 text-sm font-medium shadow-xs transition hover:bg-cream disabled:opacity-50 disabled:pointer-events-none"
            >
              {isSending ? "…" : "Withdraw"}
            </button>
            <button
              onClick={() => vaultLamports && handleWithdrawSol(vaultLamports)}
              disabled={isSending || !vaultLamports}
              className="rounded-lg border border-border-low bg-card px-3 py-2.5 text-xs font-medium shadow-xs transition hover:bg-cream disabled:opacity-50 disabled:pointer-events-none"
            >
              Max
            </button>
          </div>
        </div>
      )}

      {tab === "spl" && (
        <div className="space-y-4">
          {/* Mint Input */}
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wide text-muted">
              Token Mint Address
            </label>
            <input
              type="text"
              placeholder="e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
              value={mintInput}
              onChange={(e) => setMintInput(e.target.value)}
              disabled={isSending}
              className="w-full rounded-lg border border-border-low bg-card px-4 py-2.5 font-mono text-xs outline-none transition placeholder:text-muted focus:border-foreground/30 disabled:opacity-50 disabled:pointer-events-none"
            />
          </div>

          {/* Vault Token Balance */}
          {splDecimals != null && (
            <div className="rounded-xl border border-border-low bg-cream/30 p-4">
              <p className="text-xs uppercase tracking-wide text-muted">Vault Token Balance</p>
              <p className="mt-1 text-3xl font-bold tabular-nums">
                {vaultSplBalance ?? "0"}
              </p>
              {vaultAta && (
                <a
                  href={getExplorerUrl(`/address/${vaultAta}`)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 block truncate font-mono text-xs text-muted underline underline-offset-2"
                >
                  {vaultAta}
                </a>
              )}
            </div>
          )}

          {/* Amount + Buttons */}
          <div className="flex gap-3">
            <input
              type="number"
              min="0"
              step="any"
              placeholder="Amount"
              value={splAmount}
              onChange={(e) => setSplAmount(e.target.value)}
              disabled={isSending || splDecimals == null}
              className="flex-1 rounded-lg border border-border-low bg-card px-4 py-2.5 text-sm outline-none transition placeholder:text-muted focus:border-foreground/30 disabled:opacity-50 disabled:pointer-events-none"
            />
            <button
              onClick={() => handleSpl("deposit")}
              disabled={isSending || !splAmount || parseFloat(splAmount) <= 0 || splDecimals == null}
              className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-xs transition hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
            >
              {isSending ? "…" : "Deposit"}
            </button>
            <button
              onClick={() => handleSpl("withdraw")}
              disabled={isSending || !splAmount || parseFloat(splAmount) <= 0 || splDecimals == null}
              className="rounded-lg border border-border-low bg-card px-4 py-2.5 text-sm font-medium shadow-xs transition hover:bg-cream disabled:opacity-50 disabled:pointer-events-none"
            >
              {isSending ? "…" : "Withdraw"}
            </button>
          </div>
          {splDecimals == null && mintInput && (
            <p className="text-xs text-muted">
              Paste a valid SPL token mint address on the current cluster to continue.
            </p>
          )}
        </div>
      )}

      {/* Educational Footer */}
      <div className="border-t border-border-low pt-4 text-xs text-muted">
        <p className="mb-2">
          This vault is an{" "}
          <a
            href="https://www.anchor-lang.com/docs"
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2"
          >
            Anchor program
          </a>{" "}
          deployed on devnet. The SPL side uses Associated Token Accounts owned by your vault PDA.
        </p>
      </div>
    </section>
  );
}
