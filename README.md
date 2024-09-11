# Rescue DEGEN Chain Airdrop

This script rescues WDEGEN airdropped to Coinbase Smart Wallets on Degen chain.

It does the following:

1. Deploys your Coinbase Smart Wallet to Degen Chain
2. Replays the operation that adds the recovery account to your Coinbase Smart Wallet
3. Sends your WDEGEN to the destination address e.g. a Metamask wallet

## Prerequisites

1. Must have added a recovery account to your Coinbase Smart Wallet. Do that here: https://keys.coinbase.com/settings
2. Node.js installed on your machine. This script was tested with Node.js v20.17.0.

## Usage

```
npx rescue-degen-airdrop --wallet <wallet-address> --destination <destination-address>

Options:
  --help         Show help                                    [boolean]
  --version      Show version number                          [boolean]
  --wallet       Coinbase Smart Wallet address      [string] [required]
  --destination  Destination address                [string] [required]
```

You will be prompted for your 13 word recovery phrase.

## Development

```
pnpm install
```

```
pnpm run tsx src/index.ts
```

Run a fork of DEGEN chain:

```
anvil --fork-url "https://rpc.degen.tips"
```

```
RPC_URL_666666666="http://127.0.0.1:8545" pnpm run tsx src/index.ts
```
