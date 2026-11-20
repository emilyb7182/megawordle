import fs from "fs";
import wordListPath from "word-list";
import { wordList as commonWords } from "random-words";
import { NextResponse } from "next/server";
import { createPublicClient, encodePacked, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONTRACT_ADDRESS, megaethTestnet } from "../../../lib/contract";

const WEB3_WORDS = [
  "BLOCK", "CHAIN", "ETHER", "PROOF", "STAKE",
  "NONCE", "TOKEN", "VAULT", "YIELD", "SOLID",
  "NODES", "LAYER", "SPEED", "FLASH", "SMART",
];

const TARGET_WORDS = Array.from(
  new Set([
    ...WEB3_WORDS,
    ...commonWords
      .map((w: string) => w.trim().toUpperCase())
      .filter((w: string) => /^[A-Z]{5}$/.test(w)),
  ])
);

const VALID_WORDS = new Set<string>(
  fs
    .readFileSync(wordListPath, "utf8")
    .split("\n")
    .map((w) => w.trim().toUpperCase())
    .filter((w) => w.length === 5)
);

for (const word of TARGET_WORDS) {
  VALID_WORDS.add(word);
}

// 20s visible UI clock + 2s network latency grace buffer on server
const TURN_LIMIT_MS = 22_000;

interface GameSession {
  player: string;
  guesses: string[];
  finished: boolean;
  lastActionAt: number;
}
const activeSessions = new Map<number, GameSession>();

const publicClient = createPublicClient({
  chain: megaethTestnet,
  transport: http(),
});

function getSecretWord(gameId: number): string {
  const secretSalt = process.env.GAME_SIGNER_PRIVATE_KEY || "FALLBACK_SECRET";
  const hash = keccak256(encodePacked(["uint256", "string"], [BigInt(gameId), secretSalt]));
  const index = Number(BigInt(hash) % BigInt(TARGET_WORDS.length));
  return TARGET_WORDS[index];
}

function evaluateGuess(guess: string, target: string): ("correct" | "present" | "absent")[] {
  const result: ("correct" | "present" | "absent")[] = Array(5).fill("absent");
  const targetChars = target.split("");
  const used = Array(5).fill(false);

  for (let i = 0; i < 5; i++) {
    if (guess[i] === targetChars[i]) {
      result[i] = "correct";
      used[i] = true;
    }
  }

  for (let i = 0; i < 5; i++) {
    if (result[i] === "correct") continue;
    const foundIdx = targetChars.findIndex((ch, idx) => !used[idx] && ch === guess[i]);
    if (foundIdx !== -1) {
      result[i] = "present";
      used[foundIdx] = true;
    }
  }

  return result;
}

async function signGameEnd(gameId: number, player: `0x${string}`, attemptNumber: number, won: boolean) {
  const account = privateKeyToAccount(process.env.GAME_SIGNER_PRIVATE_KEY as `0x${string}`);
  const messageHash = keccak256(
    encodePacked(
      ["uint256", "address", "uint8", "bool"],
      [BigInt(gameId), player, Math.max(1, attemptNumber), won]
    )
  );
  return account.signMessage({ message: { raw: messageHash } });
}

export async function POST(req: Request) {
  try {
    const { gameId, player, guess, action } = await req.json();
    const numericId = Number(gameId);
    const cleanPlayer = String(player || "").toLowerCase();

    if (!numericId || !/^0x[a-f0-9]{40}$/.test(cleanPlayer)) {
      return NextResponse.json({ error: "Invalid game or player" }, { status: 400 });
    }

    // 1. Initialize or fetch server-enforced session
    let session = activeSessions.get(numericId);
    if (!session) {
      const logs = await publicClient.getLogs({
        address: CONTRACT_ADDRESS,
        event: {
          type: "event",
          name: "GameStarted",
          inputs: [
            { name: "gameId", type: "uint256", indexed: true },
            { name: "player", type: "address", indexed: true },
            { name: "wager", type: "uint256", indexed: false },
          ],
        },
        args: { gameId: BigInt(numericId) },
        fromBlock: BigInt(0),
      });

      if (logs.length === 0 || logs[0].args.player?.toLowerCase() !== cleanPlayer) {
        return NextResponse.json({ error: "Unverified or unauthorized gameId" }, { status: 403 });
      }

      session = {
        player: cleanPlayer,
        guesses: [],
        finished: false,
        lastActionAt: Date.now(),
      };
      activeSessions.set(numericId, session);
    }

    if (session.player !== cleanPlayer) {
      return NextResponse.json({ error: "Player mismatch" }, { status: 403 });
    }

    if (session.finished || session.guesses.length >= 6) {
      return NextResponse.json({ error: "Game is already over" }, { status: 400 });
    }

    // 2. Check shot clock expiration (either via UI timeout event or elapsed server time)
    const elapsed = Date.now() - session.lastActionAt;
    if (action === "timeout" || elapsed > TURN_LIMIT_MS) {
      session.finished = true;
      const secret = getSecretWord(numericId);
      const signature = await signGameEnd(numericId, player as `0x${string}`, session.guesses.length, false);
      return NextResponse.json({
        timedOut: true,
        won: false,
        gameOver: true,
        signature,
        secretReveal: secret,
      });
    }

    // Start clock handshake right when game begins on frontend
    if (action === "init") {
      session.lastActionAt = Date.now();
      return NextResponse.json({ ok: true, timeLimitSeconds: 20 });
    }

    // 3. Validate word & evaluate guess
    const cleanGuess = String(guess || "").trim().toUpperCase();
    if (!/^[A-Z]{5}$/.test(cleanGuess)) {
      return NextResponse.json({ error: "Guess must be 5 letters" }, { status: 400 });
    }

    if (!VALID_WORDS.has(cleanGuess)) {
      return NextResponse.json({ error: `"${cleanGuess}" is not a valid word.` }, { status: 400 });
    }

    session.guesses.push(cleanGuess);
    session.lastActionAt = Date.now(); // Reset 20s clock for next guess
    const attemptNumber = session.guesses.length;

    const secret = getSecretWord(numericId);
    const evaluation = evaluateGuess(cleanGuess, secret);
    const won = cleanGuess === secret;
    const gameOver = won || attemptNumber >= 6;

    let signature: `0x${string}` | null = null;
    let secretReveal: string | null = null;

    if (gameOver) {
      session.finished = true;
      signature = await signGameEnd(numericId, player as `0x${string}`, attemptNumber, won);
      secretReveal = secret;
    }

    return NextResponse.json({
      evaluation,
      won,
      gameOver,
      signature,
      secretReveal,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
