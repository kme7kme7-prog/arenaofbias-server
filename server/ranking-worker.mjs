import { parentPort, workerData } from 'node:worker_threads';
import { entityKey, modelKey } from './catalog.mjs';
import { rankEntries, rankWorks, groupV3 } from './ranking.mjs';

const modelOf = (work) => work.modelKey ?? modelKey(work);
const keyOf = workerData.by === 'model' ? modelOf : (work) => work.configKey ?? entityKey(work);
if (workerData.groupV3) {
  parentPort.postMessage(groupV3(workerData.rows, workerData.groupV3));
} else parentPort.postMessage(workerData.by === 'work' ? rankWorks(workerData.votes, keyOf) : rankEntries(workerData.votes, keyOf, {
  ...workerData.limits, scoring: workerData.scoring, voterModelKey: workerData.diminishVoterWeight ? modelOf : null,
}));
