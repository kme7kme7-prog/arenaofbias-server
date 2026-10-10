// Only the identified demo's surrounding tabletop is extended in the local
// response. UV repeats compensate for scale so the wood grain stays its size.
export const LAMP_TABLE = Object.freeze({
  workId: 'dp-021-gpt-6-astra-high',
  path: '/assets/index-BEokwfVP.js',
  sha256: '2597cf58fe310cd6c89dbd7fd3a0de10b583ac8f014d962d66471757a0327075',
});
const original = 'const y=h(new Cs(10,.19,6.7,4,.075),new ln({map:I,roughness:.9}),[0,-.125,0]);y.castShadow=!1;';
const extended = original + 'y.scale.set(40,1,40);I.repeat.set(80,80);';

export function extendStageTable(source, work, pathname) {
  if (work?.workId !== LAMP_TABLE.workId || pathname !== LAMP_TABLE.path
    || !work.modules?.some(module => module.path === pathname && module.sha256 === LAMP_TABLE.sha256)) return source;
  // Do not guess when an exported work changes, or apply twice to a response.
  if (source.includes(extended) || source.split(original).length !== 2) return source;
  return source.replace(original, extended);
}
