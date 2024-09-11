import "dotenv/config";
import readline from "readline";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  decodeFunctionData,
  erc20Abi,
  formatEther,
  http,
  parseAbi,
  parseEther,
  PublicClient,
} from "viem";
import {
  createBundlerClient,
  entryPoint06Abi,
  entryPoint06Address,
  toCoinbaseSmartAccount,
} from "viem/account-abstraction";
import { mnemonicToAccount } from "viem/accounts";
import { base, degen } from "viem/chains";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { coinbaseSmartWalletAbi } from "./abi/CoinbaseSmartWallet";

const DEGEN_RPC_URL = process.env.RPC_URL_666666666 || "https://rpc.degen.tips";
const TENDERLY_RPC_URL =
  process.env.TENDERLY_RPC_URL || "https://tenderly-rpc-proxy.vercel.app";

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option("wallet", {
    type: "string",
    description: "Coinbase Smart Wallet address",
    demandOption: true,
  })
  .option("destination", {
    type: "string",
    description: "Destination address",
    demandOption: true,
  })
  .parseSync();

async function main() {
  let mnemonic = await promptUser(
    "Please enter your 13 word recovery phrase: \n> "
  );

  const words = mnemonic.trim().split(" ");

  if (words[0].toLowerCase() !== "wallet") {
    throw new Error(
      "Invalid recovery phrase. The first word should be 'wallet'."
    );
  }

  // Remove the first word "wallet"
  mnemonic = words.slice(1).join(" ");

  if (mnemonic.split(" ").length !== 12) {
    throw new Error(
      "Invalid recovery phrase. Expected 12 words (excluding 'wallet')."
    );
  }

  const recoveryOwnerAccount = mnemonicToAccount(mnemonic);

  const degenWalletClient = createWalletClient({
    account: recoveryOwnerAccount,
    chain: degen,
    transport: http(DEGEN_RPC_URL),
  });

  const degenClient = createPublicClient({
    chain: degen,
    transport: http(DEGEN_RPC_URL),
  });

  const bundlerClient = createBundlerClient({
    chain: degen,
    transport: http(),
    userOperation: {
      async estimateFeesPerGas(parameters) {
        const fees = await degenClient.estimateFeesPerGas();
        return fees;
      },
    },
  });
  const baseClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  let deployerBalance = await degenClient.getBalance({
    address: recoveryOwnerAccount.address,
  });

  while (deployerBalance < parseEther("0.1")) {
    // Prompt to fund recovery owner account
    await promptUser(
      `Fund recovery owner account (${recoveryOwnerAccount.address}) with at least 0.1 DEGEN on Degen Chain.\n[Press enter to continue]`
    );

    deployerBalance = await degenClient.getBalance({
      address: recoveryOwnerAccount.address,
    });
  }

  console.log("Funded recovery owner account. Proceeding...");

  const response = await fetch(
    `https://scope.sh/api/logs?chain=8453&address=${argv.wallet}&cursor=0&limit=21&sort=asc`
  );
  const data = await response.json();

  const addOwnerLogs = data.logs.filter((log: any) => {
    try {
      const event = decodeEventLog({
        abi: coinbaseSmartWalletAbi,
        data: log.data,
        topics: log.topics,
      });
      return event.eventName === "AddOwner";
    } catch (error) {
      return false;
    }
  });

  const deployUserOp = await getUserOpFromCalldata(
    baseClient as any,
    addOwnerLogs[0].transactionHash
  );

  if (!addOwnerLogs[1]) {
    throw new Error("Add recovery log not found");
  }

  // Get add recovery address UserOp
  const addRecoveryOwnerLog = addOwnerLogs.find((log: any) => {
    try {
      const event = decodeEventLog({
        abi: coinbaseSmartWalletAbi,
        data: log.data,
        topics: log.topics,
      });
      // Recovery owner is a 66 character hex string
      return event.eventName === "AddOwner" && event.args.owner.length === 66;
    } catch (error) {
      return false;
    }
  });

  if (!addRecoveryOwnerLog) {
    throw new Error("AddRecoveryOwner log not found");
  }

  const userOps = await getUserOps(
    addRecoveryOwnerLog.transactionHash,
    argv.wallet
  );

  // Replayable userOps have nonce 8453 << 64
  const replayableUserOp = userOps.find((userOp: any) => {
    return userOp.nonce === BigInt(8453) << BigInt(64);
  });

  if (!replayableUserOp) {
    throw new Error("Replayable userOp not found");
  }

  console.log("Found replayable userOp");

  // Deploy wallet
  const deployTx = await degenWalletClient.sendTransaction({
    to: deployUserOp.initCode.slice(0, 42) as `0x${string}`,
    data: ("0x" + deployUserOp.initCode.slice(42)) as `0x${string}`,
  });

  console.log("Deployed", deployTx);

  // Replay recovery address on destination
  const replayTx = await degenWalletClient.writeContract({
    abi: entryPoint06Abi,
    address: entryPoint06Address,
    functionName: "handleOps",
    args: [[replayableUserOp], recoveryOwnerAccount.address],
  });

  console.log("Replayed", replayTx);

  const isValidOwner = await degenClient.readContract({
    abi: coinbaseSmartWalletAbi,
    functionName: "isOwnerAddress",
    address: argv.wallet as `0x${string}`,
    args: [recoveryOwnerAccount.address],
  });

  const actualRecoveryAddress = await degenClient.readContract({
    abi: coinbaseSmartWalletAbi,
    functionName: "ownerAtIndex",
    address: argv.wallet as `0x${string}`,
    args: [BigInt(1)],
  });

  console.log("actualRecoveryAddress", actualRecoveryAddress);

  console.log("isValidOwner", isValidOwner);

  if (!isValidOwner) {
    throw new Error("Invalid owner");
  }

  // Submit UserOp signed by recovery address that transfers funds from destination to wallet
  const smartAccount = await toCoinbaseSmartAccount({
    client: bundlerClient,
    owners: [recoveryOwnerAccount],
    address: argv.wallet as `0x${string}`,
  });

  const WDEGEN_ADDRESS = "0xEb54dACB4C2ccb64F8074eceEa33b5eBb38E5387";
  const wdegenBalance = await degenClient.readContract({
    abi: parseAbi([
      "function balanceOf(address account) view returns (uint256)",
    ]),
    address: WDEGEN_ADDRESS,
    functionName: "balanceOf",
    args: [smartAccount.address],
  });

  const destinationAddress = argv.destination as `0x${string}`;
  console.log(
    "transferring",
    formatEther(wdegenBalance),
    "to",
    destinationAddress
  );

  const userOperation = await bundlerClient.prepareUserOperation({
    account: smartAccount,
    calls: [
      {
        abi: erc20Abi,
        functionName: "transfer",
        to: WDEGEN_ADDRESS,
        args: [destinationAddress as `0x${string}`, wdegenBalance],
      },
    ],
    maxFeePerGas: parseEther("1", "gwei"),
    callGasLimit: BigInt(2_000_000),
    preVerificationGas: BigInt(2_000_000),
    verificationGasLimit: BigInt(1_000_000),
    maxPriorityFeePerGas: parseEther("1", "gwei"),
    initCode: "0x",
  });

  const signature = await smartAccount.signUserOperation(userOperation);

  const destinationBalanceBefore = await degenClient.readContract({
    abi: erc20Abi,
    address: WDEGEN_ADDRESS,
    functionName: "balanceOf",
    args: [destinationAddress],
  });

  const rescueTx = await degenWalletClient.writeContract({
    abi: entryPoint06Abi,
    address: entryPoint06Address,
    functionName: "handleOps",
    args: [
      [{ ...userOperation, initCode: "0x", signature }],
      recoveryOwnerAccount.address,
    ],
  });

  console.log("rescueTx", rescueTx);

  const rescueReceipt = await degenClient.getTransactionReceipt({
    hash: rescueTx,
  });

  // Find transfer log
  const transferLog = rescueReceipt.logs.find((log) => {
    try {
      const event = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics,
      });
      return event.eventName === "Transfer";
    } catch (error) {
      return false;
    }
  });

  if (!transferLog) {
    throw new Error("Transfer log not found");
  }

  // get balance of destination
  const destinationBalanceAfter = await degenClient.readContract({
    abi: erc20Abi,
    address: WDEGEN_ADDRESS,
    functionName: "balanceOf",
    args: [destinationAddress],
  });

  if (destinationBalanceAfter === destinationBalanceBefore) {
    throw new Error("Destination balance didn't change");
  }

  console.log("destinationBalanceAfter", formatEther(destinationBalanceAfter));
  console.log("Success!");
}

async function getUserOpFromCalldata(
  client: PublicClient,
  transactionHash: `0x${string}`
) {
  const deployReceipt = await client.getTransactionReceipt({
    hash: transactionHash,
  });
  const deployTransaction = await client.getTransaction({
    hash: transactionHash,
  });

  const userOpEventLog = deployReceipt.logs.find((log) => {
    try {
      const event = decodeEventLog({
        abi: entryPoint06Abi,
        data: log.data,
        topics: log.topics,
      });
      return event.eventName === "UserOperationEvent";
    } catch (error) {
      return false;
    }
  });

  if (!userOpEventLog) {
    throw new Error("User operation event not found");
  }

  const decodedEvent = decodeEventLog({
    abi: entryPoint06Abi,
    data: userOpEventLog.data,
    topics: userOpEventLog.topics,
  });

  if (decodedEvent.eventName !== "UserOperationEvent") {
    throw new Error("Invalid event name");
  }

  // Find userOp with hash
  const decodedCall = decodeFunctionData({
    abi: entryPoint06Abi,
    data: deployTransaction.input,
  });

  if (decodedCall.functionName !== "handleOps") {
    throw new Error("Transaction is not a handleOps call");
  }
  const userOp = decodedCall.args[0][0];

  if (!userOp) {
    throw new Error("User operation not found");
  }

  return userOp;
}

async function traceTransaction(transactionHash: string) {
  const response = await fetch(TENDERLY_RPC_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "tenderly_traceTransaction",
      params: [transactionHash],
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error status: ${response.status}`);
  }

  const data = await response.json();
  return data.result;
}

async function getUserOps(transactionHash: string, sender?: string) {
  const { trace } = await traceTransaction(transactionHash);

  const handleOpsCalls = trace.filter(
    (step: any) =>
      step.type === "CALL" &&
      step.to.toLowerCase() === entryPoint06Address.toLowerCase() &&
      step.input.startsWith("0x1fad948c") // handleOps
  );

  const userOps = handleOpsCalls.flatMap((step: any) => {
    const decoded = decodeFunctionData({
      abi: entryPoint06Abi,
      data: step.input,
    });

    if (decoded.functionName === "handleOps") {
      return decoded.args[0].filter((userOp) =>
        sender ? userOp.sender.toLowerCase() === sender?.toLowerCase() : true
      );
    }

    return [];
  });

  return userOps;
}

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
