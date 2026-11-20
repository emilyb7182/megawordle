import { defineChain } from "viem";

export const megaethTestnet = defineChain({
  id: 6343,
  name: "MegaETH Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://carrot.megaeth.com/rpc"] },
  },
  blockExplorers: {
    default: { name: "MegaETH Explorer", url: "https://megaeth-testnet.explorer.caldera.xyz" },
  },
});

export const CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS?.trim() || "0x344B09F5DDc3Fb90E62a7391C0F621FA3B909F92") as `0x${string}`;

export const MEGA_WORDLE_ABI = [
  {
    type: "function",
    name: "ENTRY_FEE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "startGame",
    stateMutability: "payable",
    inputs: [],
    outputs: [{ name: "gameId", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimPayout",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gameId", type: "uint256" },
      { name: "guessesUsed", type: "uint8" },
      { name: "won", type: "bool" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "GameStarted",
    inputs: [
      { name: "gameId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "wager", type: "uint256", indexed: false },
    ],
  },
] as const;
