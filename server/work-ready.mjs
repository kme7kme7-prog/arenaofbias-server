// Entertainment readiness follows visible content, not a timeout or window.load.
// Keep the formal comparison probe separate from this entertainment policy.
export function entertainmentProbeTag(scene = false) {
  return `<script data-aob-probe>(function(){
var scene=${JSON.stringify(scene)},posted=false,dom=false,drawn=false,stable=0;
try{parent.postMessage('aob:work-loading','*');}catch(e){}
function mark(){drawn=true;}
if(scene){
  [window.WebGLRenderingContext,window.WebGL2RenderingContext].forEach(function(Type){
    if(!Type)return;
    ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced'].forEach(function(name){
      var base=Type.prototype[name];if(typeof base!=='function')return;
      Type.prototype[name]=function(){var result=base.apply(this,arguments);mark();return result;};
    });
  });
  if(window.CanvasRenderingContext2D){
    ['drawImage','fillRect','stroke','fill'].forEach(function(name){
      var base=CanvasRenderingContext2D.prototype[name];
      CanvasRenderingContext2D.prototype[name]=function(){var result=base.apply(this,arguments);
        if(this.canvas.width>=innerWidth*.2&&this.canvas.height>=innerHeight*.2)mark();return result;};
    });
  }
}
function loadingOverlay(){
  var nodes=document.querySelectorAll('[id],[class],[role="progressbar"],[aria-busy="true"]');
  for(var i=0;i<nodes.length;i++){
    var node=nodes[i],name=(node.id+' '+(typeof node.className==='string'?node.className:'')).toLowerCase();
    if(!/(?:load|preload|splash|boot)/.test(name)&&node.getAttribute('aria-busy')!=='true'&&node.getAttribute('role')!=='progressbar')continue;
    var r=node.getBoundingClientRect();if(r.width<innerWidth*.35||r.height<innerHeight*.25)continue;
    var s=getComputedStyle(node);
    if(s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>.05&&(s.position==='fixed'||s.position==='absolute'))return true;
  }
  return false;
}
function tick(){
  if(posted)return;
  if(dom&&(!scene||drawn||(document.readyState==='complete'&&!document.querySelector('canvas')))&&!loadingOverlay())stable++;else stable=0;
  if(stable>=2){posted=true;try{parent.postMessage('aob:work-ready','*');}catch(e){}return;}
  setTimeout(tick,80);
}
function start(){dom=true;setTimeout(tick,0);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();</script>`;
}
