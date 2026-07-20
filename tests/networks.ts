import { type SetupOption, setupContext } from '@acala-network/chopsticks-testing';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

/** Frequency parachain ID on Polkadot mainnet */
export const FREQUENCY_PARA_ID = 2091;

/** Coretime system parachain ID on Polkadot */
export const CORETIME_PARA_ID = 1005;

const endpoints = {
  polkadot: ['wss://rpc.ibp.network/polkadot', 'wss://polkadot-rpc.dwellir.com'],
  frequency: ['wss://0.rpc.frequency.xyz'],
};

const toNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return Number(value);
};

export type Network = Awaited<ReturnType<typeof setupContext>>;

export default {
  polkadot: (options?: Partial<SetupOption>): Promise<Network> => {
    const config = {
      wasmOverride: process.env.POLKADOT_WASM || undefined,
      blockNumber: toNumber(process.env.POLKADOT_BLOCK_NUMBER) || 27409884,
      endpoint: process.env.POLKADOT_ENDPOINT ?? endpoints.polkadot,
      runtimeLogLevel: 5,
      db: !process.env.RUN_TESTS_WITHOUT_DB ? './db/polkadot-db.sqlite' : undefined,
      ...options,
    };
    console.log('Setting up Polkadot network with options:', config);
    return setupContext(config);
  },
  frequency: (options?: Partial<SetupOption>): Promise<Network> => {
    const config = {
      wasmOverride: process.env.FREQUENCY_WASM || undefined,
      allowUnresolvedImports: true,
      mockSignatureHost: true,
      blockNumber: toNumber(process.env.FREQUENCY_BLOCK_NUMBER) || 9117938,
      endpoint: process.env.FREQUENCY_ENDPOINT ?? endpoints.frequency,
      db: !process.env.RUN_TESTS_WITHOUT_DB ? './db/frequency-db.sqlite' : undefined,
      runtimeLogLevel: 5,
      processQueuedMessages: true,
      ...options,
    };
    console.log('Setting up Frequency network with options:', config);
    return setupContext(config);
  },
};
