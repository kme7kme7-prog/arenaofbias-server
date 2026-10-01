import { parentPort, workerData } from 'node:worker_threads';
import { effortKey, entityKey, modelKey } from './catalog.mjs';
import { rankEntries, rankWorks } from './ranking.mjs';

const keyOf = workerData.by === 'model' ? (work) => work.modelKey ?? modelKey(work) : (work) => work.configKey ?? entityKey(work);
parentPort.postMessage(workerData.by === 'work' ? rankWorks(workerData.votes, keyOf) : rankEntries(workerData.votes, keyOf, workerData.limits));
