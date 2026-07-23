import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setStorage } from '@acala-network/chopsticks-core';
import { withExpect } from '@acala-network/chopsticks-testing';
import { connectVertical, connectParachains } from '@acala-network/chopsticks';
import {
  getAccountBalance,
  getChildSovereignAccount,
  getSiblingSovereignAccount,
  scheduleRootCall,
} from './util.js';
import networks, { type Network, FREQUENCY_PARA_ID, CORETIME_PARA_ID } from './networks.js';

const { checkSystemEvents, checkHrmp } = withExpect(expect);

const DOT_UNIT = 10_000_000_000n;
const TASK = FREQUENCY_PARA_ID;

type ScheduleItem = {
  mask: string;
  assignment?: { task?: number };
};

function assignmentTask(item: ScheduleItem): number | null {
  const task = item.assignment?.task;
  return task === undefined ? null : Number(task);
}

async function findCoreForTask(api: Network['api'], task: number): Promise<number> {
  const workplanEntries = await api.query.broker.workplan.entries();
  for (const [key, value] of workplanEntries) {
    const schedule = value.toJSON() as ScheduleItem[];
    if (schedule?.some((item) => assignmentTask(item) === task)) {
      const args = key.args[0].toJSON() as [number, number];
      return Number(args[1]);
    }
  }

  const workloadEntries = await api.query.broker.workload.entries();
  for (const [key, value] of workloadEntries) {
    const schedule = value.toJSON() as ScheduleItem[];
    if (schedule?.some((item) => assignmentTask(item) === task)) {
      return key.args[0].toNumber();
    }
  }

  throw new Error(`No broker workload/workplan assignment found for task ${task}`);
}

/**
 * workload_end_hint: lease.until if leased; else potentialRenewals.when if present;
 * else saleInfo.regionBegin (expiring this sale).
 */
async function findWorkloadEndHint(api: Network['api'], task: number): Promise<number> {
  const leases = (await api.query.broker.leases()).toJSON() as Array<{
    until: number;
    task: number;
  }>;
  const lease = leases?.find((entry) => Number(entry.task) === task);
  if (lease) {
    return Number(lease.until);
  }

  const potentialEntries = await api.query.broker.potentialRenewals.entries();
  for (const [key, value] of potentialEntries) {
    const encoded = JSON.stringify(value.toJSON());
    if (encoded.includes(String(task))) {
      const { when } = key.args[0].toJSON() as { core: number; when: number };
      return Number(when);
    }
  }

  const saleInfo = (await api.query.broker.saleInfo()).toJSON() as { regionBegin: number };
  return Number(saleInfo.regionBegin);
}

/** Materialize active HRMP channels after establishChannelWithSystem confirms requests. */
async function forceActiveHrmpChannels(polkadot: Network): Promise<void> {
  const channel = {
    maxCapacity: 8,
    maxTotalSize: 8192,
    maxMessageSize: 1_048_576,
    msgCount: 0,
    totalSize: 0,
    mqcHead: null,
    senderDeposit: 0,
    recipientDeposit: 0,
  };

  await setStorage(polkadot.chain, {
    Hrmp: {
      HrmpChannels: [
        [[{ sender: FREQUENCY_PARA_ID, recipient: CORETIME_PARA_ID }], channel],
        [[{ sender: CORETIME_PARA_ID, recipient: FREQUENCY_PARA_ID }], channel],
      ],
      HrmpEgressChannelsIndex: [
        [[FREQUENCY_PARA_ID], [CORETIME_PARA_ID]],
        [[CORETIME_PARA_ID], [FREQUENCY_PARA_ID]],
      ],
      HrmpIngressChannelsIndex: [
        [[FREQUENCY_PARA_ID], [CORETIME_PARA_ID]],
        [[CORETIME_PARA_ID], [FREQUENCY_PARA_ID]],
      ],
    },
  });
  await polkadot.chain.newBlock();
}

describe('XCM Enable Auto-Renew with Coretime', async () => {
  let frequency: Network;
  let polkadot: Network;
  let coretime: Network;

  beforeAll(async () => {
    frequency = await networks.frequency();
    polkadot = await networks.polkadot();
    coretime = await networks.coretime();
  }, 600000);

  afterAll(async () => {
    await frequency?.teardown();
    await polkadot?.teardown();
    await coretime?.teardown();
  });

  it('opens HRMP with Coretime then enables broker auto-renew via governance XCM', async () => {
    await connectVertical(polkadot.chain, frequency.chain);
    await connectVertical(polkadot.chain, coretime.chain);

    const RELAY_FEE = 50n * DOT_UNIT;
    const CORETIME_FEE = 1n * DOT_UNIT;
    // Enough for XCM fees now and a future bulk renewal draw (~10 DOT at current price).
    const SIBLING_FUNDING = 100n * DOT_UNIT;

    const childSovereignAccount = await getChildSovereignAccount(FREQUENCY_PARA_ID);
    const siblingSovereignAccount = await getSiblingSovereignAccount(FREQUENCY_PARA_ID);

    await setStorage(frequency.chain, {
      PolkadotXcm: {
        SafeXcmVersion: 5,
        SupportedVersion: [
          [
            [5, { V5: { parents: 1, interior: 'here' } }],
            5,
          ],
          [
            [
              5,
              {
                V5: {
                  parents: 1,
                  interior: { X1: [{ Parachain: CORETIME_PARA_ID }] },
                },
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

    await setStorage(coretime.chain, {
      System: {
        Account: [[[siblingSovereignAccount], { data: { free: SIBLING_FUNDING }, providers: 1 }]],
      },
    });

    await frequency.chain.newBlock();
    await polkadot.chain.newBlock();
    await coretime.chain.newBlock();

    // --- Phase 1: open Frequency ↔ Coretime HRMP via relay (same path as open-channel test) ---
    const hrmpOpenCall = polkadot.api.tx.hrmp.establishChannelWithSystem(CORETIME_PARA_ID);
    const openChannelMessage = {
      V3: [
        {
          WithdrawAsset: [
            {
              id: { Concrete: { parents: 0, interior: 'here' } },
              fun: { Fungible: RELAY_FEE },
            },
          ],
        },
        {
          BuyExecution: {
            fees: {
              id: { Concrete: { parents: 0, interior: 'here' } },
              fun: { Fungible: RELAY_FEE },
            },
            weightLimit: 'Unlimited',
          },
        },
        {
          Transact: {
            origin_kind: 'Native',
            require_weight_at_most: { ref_time: 12_000_000_000, proof_size: 73_603 },
            call: { encoded: hrmpOpenCall.method.toHex() },
          },
        },
        { RefundSurplus: {} },
        {
          DepositAsset: {
            assets: { Wild: 'All' },
            beneficiary: {
              parents: 0,
              interior: { X1: { Parachain: FREQUENCY_PARA_ID } },
            },
          },
        },
      ],
    };

    await scheduleRootCall(
      frequency,
      frequency.api.tx.polkadotXcm.send({ V3: { parents: 1, interior: 'here' } }, openChannelMessage)
    );
    await polkadot.chain.newBlock();

    const openRequest = await polkadot.api.query.hrmp.hrmpOpenChannelRequests({
      sender: FREQUENCY_PARA_ID,
      recipient: CORETIME_PARA_ID,
    });
    expect(openRequest.isEmpty).toBe(false);
    expect((openRequest.toJSON() as { confirmed: boolean }).confirmed).toBe(true);

    await forceActiveHrmpChannels(polkadot);
    // false => allow Chopsticks to seed empty HRMP MQC heads for missing channels
    await connectParachains([frequency.chain, coretime.chain], false);
    // Let Frequency ingest updated relay HRMP channel state before sending.
    await frequency.chain.newBlock();

    // --- Phase 2: gather enableAutoRenew params from Coretime broker state ---
    const core = await findCoreForTask(coretime.api, TASK);
    const workloadEndHint = await findWorkloadEndHint(coretime.api, TASK);
    console.log(`enableAutoRenew params: core=${core} task=${TASK} hint=${workloadEndHint}`);

    const enableCall = coretime.api.tx.broker.enableAutoRenew(core, TASK, workloadEndHint);
    const encodedEnableCall = enableCall.method.toHex();
    const callInfo = await coretime.api.call.transactionPaymentCallApi.queryCallInfo(
      enableCall.method,
      enableCall.method.toU8a().length
    );
    const weight = callInfo.weight.toJSON() as { refTime: number; proofSize: number };

    const siblingBalanceBefore = await getAccountBalance(coretime.api, siblingSovereignAccount);
    expect(siblingBalanceBefore).toBeGreaterThanOrEqual(SIBLING_FUNDING);

    const dotAsset = {
      id: { parents: 1, interior: 'Here' },
      fun: { Fungible: CORETIME_FEE },
    };

    const enableAutoRenewMessage = {
      V5: [
        { WithdrawAsset: [dotAsset] },
        { PayFees: { asset: dotAsset } },
        {
          Transact: {
            originKind: 'SovereignAccount',
            // XCM v4+ Transact field name (maps from require_weight_at_most)
            fallbackMaxWeight: {
              refTime: weight.refTime,
              proofSize: weight.proofSize,
            },
            call: { encoded: encodedEnableCall },
          },
        },
        { RefundSurplus: null },
        {
          DepositAsset: {
            assets: { Wild: 'All' },
            beneficiary: {
              parents: 1,
              interior: { X1: [{ Parachain: FREQUENCY_PARA_ID }] },
            },
          },
        },
      ],
    };

    const coretimeDest = {
      V5: {
        parents: 1,
        interior: { X1: [{ Parachain: CORETIME_PARA_ID }] },
      },
    };

    await scheduleRootCall(
      frequency,
      frequency.api.tx.polkadotXcm.send(coretimeDest, enableAutoRenewMessage)
    );

    await checkSystemEvents(frequency).toMatchSnapshot('frequency-events');
    await checkHrmp(frequency).toMatchSnapshot('frequency-hrmp-events');

    await coretime.chain.newBlock();
    await checkSystemEvents(coretime).toMatchSnapshot('coretime-events');

    const autoRenewals = (await coretime.api.query.broker.autoRenewals()).toJSON() as Array<{
      core: number;
      task: number;
      nextRenewal: number;
    }>;
    const enabled = autoRenewals.find((entry) => Number(entry.task) === TASK);
    expect(enabled).toBeDefined();
    expect(Number(enabled!.core)).toBe(core);
    expect(Number(enabled!.task)).toBe(TASK);

    const siblingBalanceAfter = await getAccountBalance(coretime.api, siblingSovereignAccount);
    expect(siblingBalanceAfter).toBeLessThan(siblingBalanceBefore);
  });
}, 360000);
