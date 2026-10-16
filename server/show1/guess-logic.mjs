// Generated from Show1 lib/guess-logic.ts by scripts/sync-guess-core.mjs. Do not edit directly.
import { readFileSync } from 'node:fs';
const rawData = JSON.parse(readFileSync(new URL('./guess-models.json', import.meta.url), 'utf8'));
export const GUESS_DIFFICULTIES = [1, 2, 3, 4];
export const DIFFICULTY_INFO = [
    { zh: '简单', en: 'Easy' },
    { zh: '普通', en: 'Common' },
    { zh: '困难', en: 'Hard' },
    { zh: '地狱', en: 'Hell' },
];
export function poolForDifficulty(models, difficulty) {
    return models.filter((m) => m.answerEligible !== false && m.difficulty <= difficulty);
}
export const DAILY_DIFFICULTIES = [1, 2];
export function dailyPool(models) {
    return poolForDifficulty(models, 2).filter((m) => m.dailyEligible === true);
}
export const PRICE_BAND_EDGES = [0.5, 2, 8, 25, 50];
export const VENDOR_REGION = {
    'DeepSeek': 'CN',
    'Moonshot AI': 'CN',
    'Zhipu AI (Z.ai)': 'CN',
    'MiniMax': 'CN',
    'Alibaba': 'CN',
    'Xiaomi': 'CN',
    'StepFun': 'CN',
    'Tencent': 'CN',
    'Baidu': 'CN',
    'ByteDance': 'CN',
    '01.AI': 'CN',
    'inclusionAI': 'CN',
    'Meituan': 'CN',
    'RedNote': 'CN',
    'OpenAI': 'US',
    'Anthropic': 'US',
    'Google': 'US',
    'Meta': 'US',
    'xAI': 'US',
    'Microsoft': 'US',
    'Thinking Machines': 'US',
    'LMSYS': 'US',
    'Stanford': 'US',
    'NVIDIA': 'US',
    'Poolside': 'US',
    'Amazon': 'US',
    'Inception': 'US',
    'Aion Labs': 'US',
    'Sao10K': 'US',
    'IBM': 'US',
    'Mistral': 'FR',
    'Upstage': 'KR',
};
function priceBandOf(priceOut) {
    if (priceOut === null || !Number.isFinite(priceOut))
        return null;
    for (let i = 0; i < PRICE_BAND_EDGES.length; i++)
        if (priceOut < PRICE_BAND_EDGES[i])
            return i;
    return PRICE_BAND_EDGES.length;
}
function toModel(entry, group) {
    const priceTier = entry.priceTierOverride ?? priceBandOf(entry.priceOut);
    const answerEligible = (entry.answerEligible ?? group?.answerEligible ?? true)
        && entry.contextK !== null && priceTier !== null;
    return {
        id: entry.id,
        name: entry.name,
        vendor: entry.org,
        region: VENDOR_REGION[entry.org] ?? '??',
        released: `${entry.year}-${String(entry.month).padStart(2, '0')}`,
        openWeights: entry.openWeights,
        contextK: entry.contextK,
        modalities: entry.modality.split('+'),
        reasoning: entry.reasoning,
        priceOut: entry.priceOut,
        priceTier,
        popularity: entry.popularity,
        difficulty: (entry.difficulty ?? group?.difficulty),
        sinceDay: entry.sinceDay ?? group?.sinceDay,
        groupId: group?.id,
        aliases: entry.aliases,
        answerEligible,
        dailyEligible: answerEligible && entry.dailyEligible === true,
    };
}
function normalizeEntry(entry) {
    if (!entry.variants?.length)
        return [toModel(entry)];
    return entry.variants.map((v) => toModel(v, entry));
}
export const GUESS_MODELS = rawData.models.flatMap(normalizeEntry);
export const modelById = new Map(GUESS_MODELS.map((m) => [m.id, m]));
export function registerExtraModels(extra) {
    validateExtraModels(extra);
    const savedRegions = [];
    if (extra.vendorRegions)
        for (const [org, region] of Object.entries(extra.vendorRegions)) {
            savedRegions.push([org, VENDOR_REGION[org]]);
            VENDOR_REGION[org] = region;
        }
    const rollbackRegions = () => {
        for (const [org, old] of savedRegions)
            if (old === undefined)
                delete VENDOR_REGION[org];
            else
                VENDOR_REGION[org] = old;
    };
    const batch = [];
    const batchIds = new Set();
    try {
        for (const entry of extra.models ?? []) {
            if (entry.variants?.length)
                throw new GuessError('unknown-model', `增量模型不支持合并组（请维护主数据集）: ${entry.name}`);
            if (!Number.isInteger(entry.sinceDay) || (entry.sinceDay ?? -1) < 0)
                throw new GuessError('unknown-model', `增量模型必须带 sinceDay（每日派生生效日，dayNumber 口径）: ${entry.name}`);
            for (const m of normalizeEntry(entry)) {
                if (modelById.has(m.id) || batchIds.has(m.id))
                    throw new GuessError('unknown-model', `增量模型 id 重复: ${m.id}`);
                if ([...GUESS_MODELS, ...batch].some((existing) => existing.answerEligible !== false && sameClues(existing, m))) {
                    m.answerEligible = false;
                    m.dailyEligible = false;
                }
                batchIds.add(m.id);
                batch.push(m);
            }
        }
    }
    catch (error) {
        rollbackRegions();
        throw error;
    }
    for (const m of batch) {
        GUESS_MODELS.push(m);
        modelById.set(m.id, m);
    }
    return batch.length;
}
export function validateExtraModels(extra) {
    const invalid = (message) => { throw new GuessError('unknown-model', message); };
    if (!extra || !Array.isArray(extra.models) || extra.models.length > 2000)
        invalid('增量模型格式无效');
    for (const [org, region] of Object.entries(extra.vendorRegions ?? {})) {
        if (!org.trim() || org.length > 60 || ['__proto__', 'prototype', 'constructor'].includes(org)
            || !/^[A-Z]{2}$/.test(region)
            || (Object.hasOwn(VENDOR_REGION, org) && VENDOR_REGION[org] !== region))
            invalid('厂商地区无效或冲突');
    }
    const ids = new Set(modelById.keys());
    const names = new Set(GUESS_MODELS.map(m => normalizeGuessKey(m.name)));
    for (const entry of extra.models ?? []) {
        if (entry?.priceTierOverride !== undefined)
            invalid('固定价格档位仅由主数据集维护');
        if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(entry.id)
            || ids.has(entry.id))
            invalid('模型 id 无效或重复');
        if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 60
            || names.has(normalizeGuessKey(entry.name)))
            invalid('模型名无效或重复');
        if (typeof entry.org !== 'string' || !(Object.hasOwn(VENDOR_REGION, entry.org)
            || Object.hasOwn(extra.vendorRegions ?? {}, entry.org)))
            invalid('厂商需要登记地区');
        if (!Number.isInteger(entry.year) || entry.year < 2015 || entry.year > 2100
            || !Number.isInteger(entry.month) || entry.month < 1 || entry.month > 12
            || ![1, 2, 3, 4].includes(entry.difficulty ?? 0)
            || !Number.isInteger(entry.sinceDay) || (entry.sinceDay ?? -1) < 0
            || entry.variants !== undefined)
            invalid('日期、难度或生效日无效，增量不支持分组');
        if (typeof entry.openWeights !== 'boolean' || typeof entry.reasoning !== 'boolean'
            || (entry.answerEligible !== undefined && typeof entry.answerEligible !== 'boolean')
            || (entry.dailyEligible !== undefined && typeof entry.dailyEligible !== 'boolean'))
            invalid('模型开关必须是布尔值');
        if ((entry.contextK !== null && (!Number.isFinite(entry.contextK) || entry.contextK <= 0))
            || (entry.priceOut !== null && (!Number.isFinite(entry.priceOut) || entry.priceOut < 0))
            || !Number.isInteger(entry.popularity) || entry.popularity < 0 || entry.popularity > 100)
            invalid('模型数值无效');
        if (entry.dailyEligible === true && ((entry.difficulty ?? 4) > 2
            || entry.contextK === null || entry.priceOut === null || entry.answerEligible === false))
            invalid('每日精选仅限线索完整且可出题的简单、普通模型');
        const modalities = typeof entry.modality === 'string' ? entry.modality.split('+') : [];
        if (!modalities.includes('text') || modalities.some(m => !['text', 'image', 'audio', 'video'].includes(m))
            || new Set(modalities).size !== modalities.length)
            invalid('模型模态无效');
        if (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || entry.aliases.length > 20
            || entry.aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 100)))
            invalid('模型别名无效');
        ids.add(entry.id);
        names.add(normalizeGuessKey(entry.name));
    }
}
export const PRICE_TIERS = [
    { zh: '近免费', en: 'Near-free' },
    { zh: '便宜', en: 'Cheap' },
    { zh: '中等', en: 'Mid' },
    { zh: '贵', en: 'High' },
    { zh: '旗舰', en: 'Premium' },
    { zh: '顶档', en: 'Top tier' },
];
export const ATTRIBUTE_KEYS = [
    'vendor',
    'released',
    'openWeights',
    'contextK',
    'modalities',
    'reasoning',
    'priceTier',
];
export const GUESS_CONFIG = {
    releasedNearMonths: 6,
    contextNearRatio: 2,
};
export class GuessError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
function monthIndex(released) {
    const match = /^(\d{4})-(\d{2})$/.exec(released);
    if (!match)
        throw new GuessError('invalid-date', `bad released: ${released}`);
    return Number(match[1]) * 12 + Number(match[2]) - 1;
}
export function resolveGuess(name) {
    const key = normalizeGuessKey(name);
    if (!key)
        return null;
    const matches = GUESS_MODELS.filter(m => [m.id, m.name, ...(m.aliases ?? [])]
        .some(value => normalizeGuessKey(value) === key));
    return matches.length === 1 ? matches[0] : null;
}
function normalizeGuessKey(s) {
    return s.normalize('NFKC').toLowerCase()
        .replace(/(?:通义)?千问|通义/g, 'qwen').replace(/豆包/g, 'doubao')
        .replace(/智谱/g, 'glm').replace(/阶跃/g, 'step').replace(/龙猫/g, 'longcat')
        .replace(/[^\p{L}\p{N}]+/gu, '');
}
const VENDOR_ALIASES = {
    Alibaba: ['阿里', '通义', '千问'], ByteDance: ['字节', '豆包'],
    'Zhipu AI (Z.ai)': ['智谱'], Tencent: ['腾讯', '混元'], StepFun: ['阶跃'],
    Xiaomi: ['小米'], Baidu: ['百度', '文心'], 'Moonshot AI': ['月之暗面'],
    DeepSeek: ['深度求索'], Meituan: ['美团', '龙猫'], RedNote: ['小红书'],
    Google: ['谷歌'], '01.AI': ['零一万物'], MiniMax: ['稀宇'],
};
export function searchGuessModels(models, rawQuery, limit = 8) {
    const q = normalizeGuessKey(rawQuery);
    if (!q)
        return [];
    const tokens = rawQuery
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
    const scored = models
        .map((m) => {
        const name = normalizeGuessKey(m.name);
        const id = normalizeGuessKey(m.id);
        const aliases = [...(m.aliases ?? []), ...(VENDOR_ALIASES[m.vendor ?? ''] ?? []), m.vendor ?? '']
            .map(normalizeGuessKey);
        if (name === q)
            return { m, rank: 0 };
        if (name.startsWith(q))
            return { m, rank: 1 };
        if (name.includes(q) || id.includes(q))
            return { m, rank: 2 };
        if (aliases.some(alias => alias.includes(q)))
            return { m, rank: 3 };
        if (tokens.length > 1 &&
            tokens.every((tk) => name.includes(tk) || id.includes(tk) || aliases.some(alias => alias.includes(tk))))
            return { m, rank: 3 };
        return null;
    })
        .filter((x) => x !== null);
    scored.sort((a, b) => a.rank - b.rank ||
        (b.m.released ?? '').localeCompare(a.m.released ?? '') ||
        a.m.name.localeCompare(b.m.name));
    return scored.slice(0, limit).map((x) => x.m);
}
function judgeNumeric(guessValue, answerValue, nearThreshold, mode) {
    if (guessValue === null || answerValue === null)
        return { state: 'unknown', arrow: null };
    if (guessValue === answerValue)
        return { state: 'hit', arrow: null };
    const arrow = answerValue > guessValue ? 'up' : 'down';
    const near = mode === 'ratio'
        ? Math.max(guessValue, answerValue) / Math.min(guessValue, answerValue) <=
            nearThreshold
        : Math.abs(guessValue - answerValue) <= nearThreshold;
    return { state: near ? 'near' : 'miss', arrow };
}
export function judge(guess, answer) {
    const attributes = {};
    attributes.vendor =
        guess.vendor === answer.vendor
            ? { state: 'hit', arrow: null }
            : guess.region === answer.region
                ? { state: 'near', arrow: null }
                : { state: 'miss', arrow: null };
    attributes.released = judgeNumeric(monthIndex(guess.released), monthIndex(answer.released), GUESS_CONFIG.releasedNearMonths, 'diff');
    attributes.openWeights =
        guess.openWeights === answer.openWeights
            ? { state: 'hit', arrow: null }
            : { state: 'miss', arrow: null };
    attributes.contextK = judgeNumeric(guess.contextK, answer.contextK, GUESS_CONFIG.contextNearRatio, 'ratio');
    const guessModalities = new Set(guess.modalities);
    const answerModalities = new Set(answer.modalities);
    const sameModalities = guessModalities.size === answerModalities.size
        && [...guessModalities].every((m) => answerModalities.has(m));
    const guessMulti = guess.modalities.some((m) => m !== 'text');
    const answerMulti = answer.modalities.some((m) => m !== 'text');
    attributes.modalities =
        sameModalities
            ? { state: 'hit', arrow: null }
            : { state: guessMulti === answerMulti ? 'near' : 'miss', arrow: null };
    attributes.reasoning =
        guess.reasoning === answer.reasoning
            ? { state: 'hit', arrow: null }
            : { state: 'miss', arrow: null };
    if (guess.priceTier === null || answer.priceTier === null) {
        attributes.priceTier = { state: 'unknown', arrow: null };
    }
    else if (guess.priceTier === answer.priceTier) {
        attributes.priceTier = { state: 'hit', arrow: null };
    }
    else {
        attributes.priceTier = {
            state: Math.abs(guess.priceTier - answer.priceTier) === 1 ? 'near' : 'miss',
            arrow: answer.priceTier > guess.priceTier ? 'up' : 'down',
        };
    }
    return {
        guessId: guess.id,
        attributes,
        won: guess.id === answer.id || sameClues(guess, answer),
    };
}
export function sameClues(a, b) {
    return ATTRIBUTE_KEYS.every(key => key === 'modalities'
        ? [...new Set(a.modalities)].sort().join('+') === [...new Set(b.modalities)].sort().join('+')
        : a[key] === b[key]);
}
export function catalogRevision(models = GUESS_MODELS) {
    return `guess-v2-${stableHash(JSON.stringify(models))}`;
}
function stableHash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++)
        h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    return (h ^ (h >>> 16)) >>> 0;
}
export const GUESS_EPOCH = '2026-09-13';
export function guessDayKey(date = new Date()) {
    const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
    return shifted.toISOString().slice(0, 10);
}
export function dayNumber(date = new Date()) {
    const key = guessDayKey(date);
    const ms = Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
    const epochMs = Date.UTC(Number(GUESS_EPOCH.slice(0, 4)), Number(GUESS_EPOCH.slice(5, 7)) - 1, Number(GUESS_EPOCH.slice(8, 10)));
    return Math.round((ms - epochMs) / 86400000);
}
export function answerForDate(date = new Date(), pool = GUESS_MODELS) {
    const n = Math.max(0, dayNumber(date));
    const slots = new Map();
    for (const model of pool) {
        if (model.answerEligible === false)
            continue;
        const key = model.groupId ?? model.id;
        const slot = slots.get(key) ?? [];
        slot.push(model);
        slots.set(key, slot);
    }
    const ordered = [...slots].map(([id, variants]) => ({
        id, hash: stableHash(`daily-v2:${id}`),
        variants: variants.slice().sort((a, b) => a.id.localeCompare(b.id)),
    })).sort((a, b) => a.hash - b.hash || a.id.localeCompare(b.id));
    let start = 0;
    for (let cycle = 0;; cycle++) {
        const active = ordered.map(slot => slot.variants.filter(model => (model.sinceDay ?? 0) <= start))
            .filter(variants => variants.length > 0);
        if (!active.length)
            throw new GuessError('unknown-model', '没有可用的每日模型');
        if (n < start + active.length) {
            const variants = active[n - start];
            return variants[cycle % variants.length];
        }
        start += active.length;
    }
}
