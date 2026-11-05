// Guided blind voting trial (staff only). Besides the overall question, a trial match may carry
// one aspect question (测评点) from its category's pool. Trial answers are kept in guided_trial_votes,
// which no board reads. Pilot: 建模 only. Aspect IDs are stable; the wording may change.
export const DIMENSIONS = { aesthetic: '审美', craft: '工程完备', logic: '逻辑', diverge: '发散' };

export const ASPECTS = {
  建模: [
    { id: 'floating', dimension: 'craft', question: '哪个建模的悬空或断连现象更少？', keyword: '悬空或断连',
      hint: '拖动旋转，看各部件的连接处和贴地的地方。两边都没有就选「都很好」。' },
    { id: 'fidelity', dimension: 'logic', question: '哪个的造型更贴合题目？', keyword: '造型',
      hint: '对照提示词，看形状、结构和比例。' },
    { id: 'atmosphere', dimension: 'aesthetic', question: '哪个的氛围/环境更能衬托建模？', keyword: '氛围/环境',
      hint: '背景、地面、天空和配景。' },
    { id: 'lighting', dimension: 'aesthetic', question: '哪个的光影更有质感？', keyword: '光影',
      hint: '明暗过渡、阴影和灯光。' },
    { id: 'material', dimension: 'aesthetic', question: '哪个的材质更像真的？', keyword: '材质',
      hint: '表面的颜色、纹理和反光像不像。' },
    { id: 'extra_idea', dimension: 'diverge', question: '哪个的巧思让你眼前一亮？', keyword: '巧思',
      hint: '题目没要求、但加得恰到好处的细节。' },
  ],
};

// The pool's least answered aspect on this task, ties broken at random, so every question gathers answers.
export function pickAspect(task, answered, random) {
  const pool = ASPECTS[task?.category] ?? [];
  if (!pool.length) return null;
  const count = new Map(answered.map((row) => [row.aspect_id, row.n]));
  const least = Math.min(...pool.map((aspect) => count.get(aspect.id) ?? 0));
  const open = pool.filter((aspect) => (count.get(aspect.id) ?? 0) === least);
  return open[Math.min(open.length - 1, Math.floor(random() * open.length))];
}

export const publicAspect = (aspect) => aspect && {
  id: aspect.id, dimension: aspect.dimension, dimensionName: DIMENSIONS[aspect.dimension],
  question: aspect.question, keyword: aspect.keyword, hint: aspect.hint,
};
