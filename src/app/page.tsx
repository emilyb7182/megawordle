"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseEther,
  decodeEventLog,
} from "viem";
import { CONTRACT_ADDRESS, MEGA_WORDLE_ABI, megaethTestnet } from "../lib/contract";

type TileState = "empty" | "tbd" | "correct" | "present" | "absent";

interface RowData {
  letters: string[];
  states: TileState[];
}

const TURN_SECONDS = 20;

const TIERS=[{guesses:"1 Guess",name:"Mythic",mult:"10.0x (0.050 ETH)",color:"text-amber-400"},{guesses:"2 Guesses",name:"Epic",mult:"3.0x (0.015 ETH)",color:"text-purple-400"},{guesses:"3 Guesses",name:"Rare",mult:"1.5x (0.0075 ETH)",color:"text-sky-400"},{guesses:"4 Guesses",name:"Uncommon",mult:"1.2x (0.006 ETH)",color:"text-emerald-400"},{guesses:"5–6 Guesses",name:"Common",mult:"0.6x (0.003 ETH)",color:"text-zinc-300"},{guesses:"7–8 Guesses",name:"Scrape",mult:"0.3x (0.0015 ETH)",color:"text-orange-300"},{guesses:"Loss / Timeout",name:"Bust",mult:"0x (0 ETH)",color:"text-zinc-500"}];

export default function Home() {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [gameId, setGameId] = useState<number | null>(null);
  const [rows, setRows] = useState<RowData[]>(
    Array.from({ length: 8 }, () => ({ letters: Array(5).fill(""), states: Array(5).fill("empty") }))
  );
  const [currentRow, setCurrentRow] = useState(0);
  const [currentGuess, setCurrentGuess] = useState("");
  const [statusMsg, setStatusMsg] = useState("Connect wallet & stake 0.005 ETH to start.");
  const [loading, setLoading] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [won, setWon] = useState(false);
  const [signature, setSignature] = useState<`0x${string}` | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number>(TURN_SECONDS);
  const timeoutTriggeredRef = useRef(false);

  const publicClient = createPublicClient({
    chain: megaethTestnet,
    transport: http(),
  });

  const connectWallet = async () => {
    if (typeof window === "undefined" || !(window as unknown as { ethereum?: unknown }).ethereum) {
      setStatusMsg("Please install MetaMask or Rabby wallet.");
      return;
    }
    const ethereum = (window as unknown as { ethereum: Parameters<typeof custom>[0] }).ethereum;
    const walletClient = createWalletClient({ chain: megaethTestnet, transport: custom(ethereum) });

    const currentChainId = await walletClient.getChainId();
    if (currentChainId !== megaethTestnet.id) {
      try {
        await walletClient.switchChain({ id: megaethTestnet.id });
      } catch (switchErr: unknown) {
        const errCode = (switchErr as { code?: number })?.code;
        if (errCode === 4902) {
          await walletClient.addChain({ chain: megaethTestnet });
        }
      }
    }

    const [addr] = await walletClient.requestAddresses();
    setAddress(addr);
    setStatusMsg("Wallet connected! Ready to play.");
  };

  const handleStartGame = async () => {
    if (!address) return;
    setLoading(true);
    setStatusMsg("Confirm 0.005 ETH stake in wallet...");
    try {
      const ethereum = (window as unknown as { ethereum: Parameters<typeof custom>[0] }).ethereum;
      const walletClient = createWalletClient({ chain: megaethTestnet, transport: custom(ethereum) });

      const hash = await walletClient.writeContract({
        address: CONTRACT_ADDRESS,
        abi: MEGA_WORDLE_ABI,
        functionName: "startGame",
        value: parseEther("0.005"),
        account: address,
      });

      setStatusMsg("Confirming on MegaETH...");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      let startedId: number | null = null;
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: MEGA_WORDLE_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "GameStarted") {
            startedId = Number(decoded.args.gameId);
            break;
          }
        } catch {
          // ignore unrelated logs
        }
      }

      if (!startedId) throw new Error("Could not read GameStarted event");

      // Initialize server-side shot clock
      await fetch("/api/guess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: startedId, player: address, action: "init" }),
      });

      if(document.activeElement instanceof HTMLElement)document.activeElement.blur();window.focus();setGameId(startedId);
      setRows(Array.from({ length: 8 }, () => ({ letters: Array(5).fill(""), states: Array(5).fill("empty") })));
      setCurrentRow(0);
      setCurrentGuess("");
      setGameOver(false);
      setWon(false);
      setSignature(null);
      setClaimed(false);
      setTimeLeft(TURN_SECONDS);
      timeoutTriggeredRef.current = false;
      setStatusMsg(`Game #${startedId} active! You have 20s per guess.`);
    } catch (err: unknown) {
      setStatusMsg(err instanceof Error ? err.message : "Transaction failed");
    } finally {
      setLoading(false);
    }
  };

  // Handle shot clock expiration
  useEffect(() => {
    if (!gameId || gameOver || loading) return;

    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 0.1) {
          clearInterval(interval);
          if (!timeoutTriggeredRef.current && address) {
            timeoutTriggeredRef.current = true;
            fetch("/api/guess", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ gameId, player: address, action: "timeout" }),
            })
              .then((r) => r.json())
              .then((data) => {
                setGameOver(true);
                setWon(false);
                setStatusMsg(`Time's up! Shot clock expired. The word was ${data.secretReveal || "hidden"}.`);
              })
              .catch(() => {
                setGameOver(true);
                setWon(false);
                setStatusMsg("Time's up! Shot clock expired.");
              });
          }
          return 0;
        }
        return Number((prev - 0.1).toFixed(1));
      });
    }, 100);

    return () => clearInterval(interval);
  }, [gameId, gameOver, loading, address, currentRow]);

  const submitGuess = useCallback(async () => {
    if (!gameId || !address || currentGuess.length !== 5 || loading || gameOver) return;
    setLoading(true);
    try {
      const attemptNumber = currentRow + 1;
      const res = await fetch("/api/guess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameId,
          player: address,
          guess: currentGuess,
          attemptNumber,
        }),
      });
      const data = await res.json();

      if (data.timedOut) {
        setGameOver(true);
        setWon(false);
        setTimeLeft(0);
        setStatusMsg(`Time's up! The word was ${data.secretReveal}.`);
        return;
      }

      if (!res.ok) throw new Error(data.error || "Guess failed");

      const updatedRows = [...rows];
      updatedRows[currentRow] = {
        letters: currentGuess.split(""),
        states: data.evaluation,
      };
      setRows(updatedRows);
      setCurrentGuess("");

      if (data.gameOver) {
        setGameOver(true);
        setWon(data.won);
        setSignature(data.signature);
        setStatusMsg(
          data.won
            ? `Solved in ${attemptNumber}! Click Claim Payout below.`
            : `Out of guesses! The word was ${data.secretReveal}.`
        );
      } else {
        setCurrentRow(attemptNumber);
        setTimeLeft(TURN_SECONDS);
        timeoutTriggeredRef.current = false;
        setStatusMsg(`Guess ${attemptNumber}/8 recorded. Clock reset to 20s!`);
      }
    } catch (err: unknown) {
      setStatusMsg(err instanceof Error ? err.message : "Error checking guess");
    } finally {
      setLoading(false);
    }
  }, [gameId, address, currentGuess, loading, gameOver, currentRow, rows]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!gameId || gameOver || loading) return;
      if (e.key === "Enter") {
        submitGuess();
      } else if (e.key === "Backspace") {
        setCurrentGuess((prev) => prev.slice(0, -1));
      } else if (/^[a-zA-Z]$/.test(e.key) && currentGuess.length < 5) {
        setCurrentGuess((prev) => prev + e.key.toUpperCase());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [gameId, gameOver, loading, currentGuess, submitGuess]);

  const handleClaimPayout = async () => {
    if (!gameId || !address || !signature) return;
    setLoading(true);
    setStatusMsg("Submitting payout claim...");
    try {
      const ethereum = (window as unknown as { ethereum: Parameters<typeof custom>[0] }).ethereum;
      const walletClient = createWalletClient({ chain: megaethTestnet, transport: custom(ethereum) });

      const guessesUsed = currentRow + 1;
      const hash = await walletClient.writeContract({
        address: CONTRACT_ADDRESS,
        abi: MEGA_WORDLE_ABI,
        functionName: "claimPayout",
        args: [BigInt(gameId), guessesUsed, won, signature],
        account: address,
      });

      await publicClient.waitForTransactionReceipt({ hash });
      setClaimed(true);
      setStatusMsg("Payout settled on-chain! Start a new game anytime.");
    } catch (err: unknown) {
      setStatusMsg(err instanceof Error ? err.message : "Claim failed");
    } finally {
      setLoading(false);
    }
  };

  const tileColor = (state: TileState) => {
    switch (state) {
      case "correct":
        return "bg-emerald-600 border-emerald-500 text-white";
      case "present":
        return "bg-amber-500 border-amber-400 text-white";
      case "absent":
        return "bg-zinc-800 border-zinc-700 text-zinc-400";
      default:
        return "bg-zinc-900 border-zinc-700 text-white";
    }
  };

  const timerPct = Math.max(0, Math.min(100, (timeLeft / TURN_SECONDS) * 100));
  const timerBarColor =
    timeLeft > 10 ? "bg-emerald-500" : timeLeft > 5 ? "bg-amber-400" : "bg-red-500 animate-pulse";

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center py-10 px-4">
      <div className="w-full max-w-md flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">MEGAWORDLE</h1>
          <p className="text-xs text-zinc-400">MegaETH Testnet • 0.005 ETH • 20s Shot Clock</p>
        </div>
        {!address ? (
          <button
            onClick={connectWallet}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold"
          >
            Connect Wallet
          </button>
        ) : (
          <span className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-mono">
            {address.slice(0, 6)}...{address.slice(-4)}
          </span>
        )}
      </div>

      {/* Live 20s Shot Clock Bar */}
      {gameId !== null && !gameOver && (
        <div className="w-full max-w-xs mb-5">
          <div className="flex justify-between text-xs font-mono mb-1">
            <span className="text-zinc-400">SHOT CLOCK</span>
            <span className={timeLeft <= 5 ? "text-red-400 font-bold" : "text-zinc-200"}>
              {timeLeft.toFixed(1)}s
            </span>
          </div>
          <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-100 ${timerBarColor}`}
              style={{ width: `${timerPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Wordle Grid */}
      <div className="grid grid-rows-8 gap-2 mb-6">
        {rows.map((row, rIdx) => {
          const isCurrent = rIdx === currentRow && !gameOver && gameId !== null;
          return (
            <div key={rIdx} className="grid grid-cols-5 gap-2">
              {Array.from({ length: 5 }).map((_, cIdx) => {
                const letter = isCurrent ? currentGuess[cIdx] || "" : row.letters[cIdx];
                const state = isCurrent ? (letter ? "tbd" : "empty") : row.states[cIdx];
                return (
                  <div
                    key={cIdx}
                    className={`w-14 h-14 border-2 rounded-lg flex items-center justify-center text-2xl font-bold uppercase transition-colors ${tileColor(state)}`}
                  >
                    {letter}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Status & Actions */}
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-xl p-4 mb-6 text-center">
        <p className="text-sm text-zinc-200 mb-3">{statusMsg}</p>

        {address && (!gameId || gameOver) && (
          <button
            onClick={handleStartGame}
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 font-semibold text-sm"
          >
            {loading ? "Processing..." : "Start Game (0.005 ETH)"}
          </button>
        )}

        {gameOver && won && signature && !claimed && (
          <button
            onClick={handleClaimPayout}
            disabled={loading}
            className="w-full mt-2 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 disabled:opacity-50 font-bold text-sm"
          >
            {loading ? "Claiming..." : "Claim ETH Payout"}
          </button>
        )}
      </div>

      {/* Rarity Payout Table */}
      <div className="w-full max-w-md bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
        <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">
          Rarity Payout Tiers
        </h2>
        <div className="space-y-1.5 text-xs">
          {TIERS.map((t) => (
            <div key={t.name} className="flex justify-between">
              <span className={`font-semibold ${t.color}`}>
                {t.name} ({t.guesses})
              </span>
              <span className="font-mono text-zinc-300">{t.mult}</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
