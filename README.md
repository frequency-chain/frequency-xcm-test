# frequency-xcm-test

XCM tests for Frequency on Polkadot using Chopsticks mainnet forks.

Currently covers opening an HRMP channel with **Coretime** via Root/governance XCM (`polkadotXcm.send` scheduled as Root).

## Setup

```bash
npm install
cp .env.example .env
```

Place the Frequency runtime override (not yet on mainnet) at:

```text
wasm/frequency_runtime-mainet.wasm
```

`wasm/*.wasm` is gitignored — provide the blob locally. `.env` sets `FREQUENCY_WASM=./wasm/frequency_runtime-mainet.wasm` so Chopsticks uses that build.

## Run

```bash
npm test
npm run test:clean     # wipe chopsticks sqlite caches
npm run test:debug     # verbose Chopsticks logging
npm run lint:fix      # prettier + eslint
```

## Networks

Defaults target **Polkadot + Frequency mainnet** (Frequency para ID `2091`, Coretime `1005`).
