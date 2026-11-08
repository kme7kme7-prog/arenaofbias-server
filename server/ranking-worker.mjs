import { parentPort, workerData } from 'node:worker_threads';
import { entityKey, modelKey } from './catalog.mjs';
import { rankEntries, rankWorks } from './ranking.mjs';

const modelOf = (work) => work.modelKey ?? modelKey(work);
const keyOf = workerData.by === 'model' ? modelOf : (work) => work.configKey ?? entityKey(work);
parentPort.postMessage(workerData.by === 'work' ? rankWorks(workerData.votes, keyOf) : rankEntries(workerData.votes, keyOf, {
  ...workerData.limits, voterModelKey: workerData.diminishVoterWeight ? modelOf : null,
}));
