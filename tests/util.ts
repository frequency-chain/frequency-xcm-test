import { u8aToHex, stringToU8a, compactToU8a, hexToU8a, isHex } from '@polkadot/util';
import { blake2AsU8a, decodeAddress } from '@polkadot/util-crypto';
import { setStorage } from '@acala-network/chopsticks-core';

/**
 * Child sovereign account for a parachain on the relay chain.
 * Format: "para" + paraId (LE) + zero padding.
 * @see https://substrate.stackexchange.com/questions/1200/how-to-calculate-sovereignaccount-for-parachain/1210
 */
export async function getChildSovereignAccount(paraId: number): Promise<string> {
  const paraIdBytes = new Uint8Array(4);
  paraIdBytes[0] = paraId & 0xff;
  paraIdBytes[1] = (paraId >> 8) & 0xff;
  paraIdBytes[2] = (paraId >> 16) & 0xff;
  paraIdBytes[3] = (paraId >> 24) & 0xff;

  const accountId = new Uint8Array(32);
  accountId[0] = 0x70; // p
  accountId[1] = 0x61; // a
  accountId[2] = 0x72; // r
  accountId[3] = 0x61; // a

  for (let i = 0; i < 4; i++) {
    accountId[4 + i] = paraIdBytes[i];
  }

  return u8aToHex(accountId);
}

/**
 * Relay-local account for an AccountId32 living on a child parachain.
 *
 * Corresponds to XCM location `{ parents: 0, X2(Parachain(paraId), AccountId32(account)) }`
 * converted via Polkadot's `HashedDescription<DescribeFamily<DescribeAccountId32Terminal>>`:
 * `blake2_256( ("ChildChain", Compact(paraId), ("AccountId32", accountId)).encode() )`.
 *
 * @param paraId - Child parachain id (e.g. Frequency = 2091)
 * @param accountId - SS58 address, 0x-prefixed 32-byte hex, or raw 32 bytes
 */
export function getChildAccountSovereignAccount(
  paraId: number,
  accountId: string | Uint8Array
): string {
  const account = decodeAccountId32(accountId);

  // DescribeAccountId32Terminal: (b"AccountId32", id) as fixed-width SCALE fields
  const accountId32Prefix = stringToU8a('AccountId32');
  const interior = new Uint8Array(accountId32Prefix.length + 32);
  interior.set(accountId32Prefix, 0);
  interior.set(account, accountId32Prefix.length);

  // DescribeFamily: (b"ChildChain", Compact(paraId), interior_bytes)
  const childChainPrefix = stringToU8a('ChildChain');
  const compactPara = compactToU8a(paraId);
  const compactInteriorLen = compactToU8a(interior.length);

  const description = new Uint8Array(
    childChainPrefix.length + compactPara.length + compactInteriorLen.length + interior.length
  );
  let offset = 0;
  description.set(childChainPrefix, offset);
  offset += childChainPrefix.length;
  description.set(compactPara, offset);
  offset += compactPara.length;
  description.set(compactInteriorLen, offset);
  offset += compactInteriorLen.length;
  description.set(interior, offset);

  return u8aToHex(blake2AsU8a(description, 256));
}

function decodeAccountId32(accountId: string | Uint8Array): Uint8Array {
  if (accountId instanceof Uint8Array) {
    if (accountId.length !== 32) {
      throw new Error(`AccountId32 must be 32 bytes, got ${accountId.length}`);
    }
    return accountId;
  }

  if (isHex(accountId)) {
    const bytes = hexToU8a(accountId);
    if (bytes.length !== 32) {
      throw new Error(`AccountId32 hex must be 32 bytes, got ${bytes.length}`);
    }
    return bytes;
  }

  return decodeAddress(accountId);
}

export const getAccountBalance = async (api: any, address: string): Promise<bigint> => {
  const accountData = await api.query.system.account(address);
  return accountData.data.free.toBigInt();
};

/**
 * Schedule a call for the next block as Root via the Scheduler pallet.
 * Simulates an enacted Democracy proposal (Frequency mainnet has no Sudo).
 */
export async function scheduleRootCall(
  network: {
    api: any;
    chain: any;
  },
  call: { method: { toHex: () => string } }
): Promise<void> {
  const header = await network.api.rpc.chain.getHeader();
  const nextBlock = header.number.toNumber() + 1;

  await setStorage(network.chain, {
    Scheduler: {
      Agenda: [
        [
          [nextBlock],
          [
            {
              maybeId: null,
              priority: 63,
              call: {
                Inline: call.method.toHex(),
              },
              maybePeriodic: null,
              origin: {
                system: 'Root',
              },
            },
          ],
        ],
      ],
    },
  });

  await network.chain.newBlock();
}
