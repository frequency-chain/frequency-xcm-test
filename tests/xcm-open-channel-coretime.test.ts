import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setStorage } from '@acala-network/chopsticks-core';
import { withExpect } from '@acala-network/chopsticks-testing';
import { connectVertical } from '@acala-network/chopsticks';
import { getAccountBalance, getChildSovereignAccount, scheduleRootCall } from './util.js';
import networks, { type Network, FREQUENCY_PARA_ID, CORETIME_PARA_ID } from './networks.js';

const { checkSystemEvents, checkUmp } = withExpect(expect);

describe('XCM Channel Opening with Coretime', async () => {
  let frequency: Network;
  let polkadot: Network;

  beforeAll(async () => {
    frequency = await networks.frequency();
    polkadot = await networks.polkadot();
  }, 600000);

  afterAll(async () => {
    await frequency?.teardown();
    await polkadot?.teardown();
  });

  it('opens HRMP channel with Coretime via governance XCM', async () => {
    await connectVertical(polkadot.chain, frequency.chain);

    const DOT_UNIT = 10_000_000_000n;

    const POLKADOT_FEE = 50n * DOT_UNIT;

    // Frequency parachain sovereign on Polkadot. It pays relay XCM fees when send is Root
    const childSovereignAccount = await getChildSovereignAccount(FREQUENCY_PARA_ID);

    await setStorage(frequency.chain, {
      PolkadotXcm: {
        SafeXcmVersion: 5,
        SupportedVersion: [
          [
            [
              5,
              {
                V5: { parents: 1, interior: 'here' },
              },
            ],
            5,
          ],
        ],
      },
    });

    await setStorage(polkadot.chain, {
      System: {
        Account: [[[childSovereignAccount], { data: { free: 1000n * DOT_UNIT }, providers: 1 }]],
      },
    });

    await frequency.chain.newBlock();
    await polkadot.chain.newBlock();

    const frequencySovereignBalanceBefore = await getAccountBalance(
      polkadot.api,
      childSovereignAccount
    );
    expect(frequencySovereignBalanceBefore).toBeGreaterThanOrEqual(1000n * DOT_UNIT);

    const hrmpOpenCall = polkadot.api.tx.hrmp.establishChannelWithSystem(CORETIME_PARA_ID);
    const encodedHrmpCall = hrmpOpenCall.method.toHex();

    const destination = {
      V3: {
        parents: 1,
        interior: 'here',
      },
    };

    const message = {
      V3: [
        {
          WithdrawAsset: [
            {
              id: {
                Concrete: {
                  parents: 0,
                  interior: 'here',
                },
              },
              fun: {
                Fungible: POLKADOT_FEE,
              },
            },
          ],
        },
        {
          BuyExecution: {
            fees: {
              id: {
                Concrete: {
                  parents: 0,
                  interior: 'here',
                },
              },
              fun: {
                Fungible: POLKADOT_FEE,
              },
            },
            weightLimit: 'Unlimited',
          },
        },
        {
          Transact: {
            // establishChannelWithSystem requires parachain origin (ensure_parachain)
            origin_kind: 'Native',
            require_weight_at_most: {
              ref_time: 12000000000,
              proof_size: 73603,
            },
            call: {
              encoded: encodedHrmpCall,
            },
          },
        },
        {
          RefundSurplus: {},
        },
        {
          DepositAsset: {
            assets: {
              Wild: 'All',
            },
            beneficiary: {
              parents: 0,
              interior: {
                X1: {
                  Parachain: FREQUENCY_PARA_ID,
                },
              },
            },
          },
        },
      ],
    };

    // Schedule polkadotXcm.send as Root to simulate an enacted Democracy proposal.
    const sendCall = frequency.api.tx.polkadotXcm.send(destination, message);
    await scheduleRootCall(frequency, sendCall);

    await checkSystemEvents(frequency).toMatchSnapshot('frequency-events');
    await checkUmp(frequency).toMatchSnapshot('frequency-ump-events');

    await polkadot.chain.newBlock();

    await checkSystemEvents(polkadot).toMatchSnapshot('polkadot-events');

    // establishChannelWithSystem creates confirmed open requests.
    const openRequest = await polkadot.api.query.hrmp.hrmpOpenChannelRequests({
      sender: FREQUENCY_PARA_ID,
      recipient: CORETIME_PARA_ID,
    });
    expect(openRequest.isEmpty).toBe(false);
    expect((openRequest.toJSON() as { confirmed: boolean }).confirmed).toBe(true);

    const reverseOpenRequest = await polkadot.api.query.hrmp.hrmpOpenChannelRequests({
      sender: CORETIME_PARA_ID,
      recipient: FREQUENCY_PARA_ID,
    });

    expect(reverseOpenRequest.isEmpty).toBe(false);
    expect((reverseOpenRequest.toJSON() as { confirmed: boolean }).confirmed).toBe(true);

    const frequencySovereignBalanceAfter = await getAccountBalance(
      polkadot.api,
      childSovereignAccount
    );
    expect(frequencySovereignBalanceAfter).toBeLessThan(frequencySovereignBalanceBefore);
  });
}, 240000);
