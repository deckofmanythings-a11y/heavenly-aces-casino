// cards.js — shared playing-card renderer + flip-slot DOM helper.
// Self-contained (injects its own <style>), following the cloche-dice.js/winner-modal.js
// convention: copy into a new game's root as-is, no build step, no external image assets.
// All 52 faces + the card back are generated SVG, not downloaded art, so there's no
// per-file licensing to track and every face renders crisp at any size.
(function(){

const RANK_LABEL={14:'A',13:'K',12:'Q',11:'J',10:'10',9:'9',8:'8',7:'7',6:'6',5:'5',4:'4',3:'3',2:'2'};
const SUIT_SYMBOL={S:'♠',H:'♥',D:'♦',C:'♣'};
const SUIT_COLOR={S:'#161616',C:'#161616',H:'#c41230',D:'#c41230'};

// Simplified pip grid: columns at 25/50/75% width, rows at 12/31/50/69/88% height.
// Cells in the bottom two rows are rotated 180deg to read correctly right-side-up,
// matching how real cards mirror their pip layout across the vertical center.
const L=25,M=50,R=75, Y0=14,Y1=32,Y2=50,Y3=68,Y4=86;
const PIP_LAYOUT={
  2:[[M,Y0],[M,Y4,1]],
  3:[[M,Y0],[M,Y2],[M,Y4,1]],
  4:[[L,Y0],[R,Y0],[L,Y4,1],[R,Y4,1]],
  5:[[L,Y0],[R,Y0],[M,Y2],[L,Y4,1],[R,Y4,1]],
  6:[[L,Y0],[R,Y0],[L,Y2],[R,Y2],[L,Y4,1],[R,Y4,1]],
  7:[[L,Y0],[R,Y0],[M,Y1],[L,Y2],[R,Y2],[L,Y4,1],[R,Y4,1]],
  8:[[L,Y0],[R,Y0],[M,Y1],[L,Y2],[R,Y2],[M,Y3,1],[L,Y4,1],[R,Y4,1]],
  9:[[L,Y0],[R,Y0],[L,Y1],[R,Y1],[M,Y2],[L,Y3,1],[R,Y3,1],[L,Y4,1],[R,Y4,1]],
  10:[[L,Y0],[R,Y0],[M,Y1],[L,Y1],[R,Y1],[L,Y3,1],[R,Y3,1],[M,Y3,1],[L,Y4,1],[R,Y4,1]],
};

function esc(s){return s;}

function pipSVG(x,y,suit,rot,size){
  const t=rot?' transform="rotate(180 '+x+' '+y+')"':'';
  return '<text x="'+x+'" y="'+y+'" font-size="'+size+'" text-anchor="middle" dominant-baseline="central" fill="'+SUIT_COLOR[suit]+'"'+t+'>'+SUIT_SYMBOL[suit]+'</text>';
}

function cornerSVG(rank,suit){
  const lbl=RANK_LABEL[rank],col=SUIT_COLOR[suit];
  function corner(x,y,rot){
    const t=rot?' transform="rotate(180 '+x+' '+y+')"':'';
    return '<g'+t+'>'
      +'<text x="'+x+'" y="'+y+'" font-size="11" font-weight="700" text-anchor="middle" fill="'+col+'" font-family="Georgia,serif">'+lbl+'</text>'
      +'<text x="'+x+'" y="'+(y+11)+'" font-size="10" text-anchor="middle" fill="'+col+'">'+SUIT_SYMBOL[suit]+'</text>'
      +'</g>';
  }
  return corner(11,16,0)+corner(89,124,1);
}

function centerContentSVG(rank,suit){
  if(rank===14){
    return '<text x="50" y="74" font-size="46" text-anchor="middle" dominant-baseline="central" fill="'+SUIT_COLOR[suit]+'">'+SUIT_SYMBOL[suit]+'</text>';
  }
  if(rank>=11){
    // Face card: mirrored ornamental letter, no illustrated figure -- deliberately
    // stylized rather than a literal court-card portrait.
    const lbl=RANK_LABEL[rank],col=SUIT_COLOR[suit];
    let h='<rect x="18" y="24" width="64" height="92" rx="6" fill="none" stroke="'+col+'" stroke-width="1.5" opacity="0.55"/>';
    h+='<rect x="23" y="29" width="54" height="82" rx="4" fill="none" stroke="'+col+'" stroke-width="0.75" opacity="0.35"/>';
    h+='<text x="50" y="58" font-size="30" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="'+col+'" font-family="Georgia,serif">'+lbl+'</text>';
    h+='<text x="50" y="82" font-size="18" text-anchor="middle" dominant-baseline="central" fill="'+col+'">'+SUIT_SYMBOL[suit]+'</text>';
    h+='<g transform="rotate(180 50 70)"><text x="50" y="58" font-size="30" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="'+col+'" font-family="Georgia,serif">'+lbl+'</text></g>';
    return h;
  }
  const layout=PIP_LAYOUT[rank]||[];
  return layout.map(p=>pipSVG(p[0],p[1],suit,p[2],14)).join('');
}

function svgFront(card){
  const rank=card.r,suit=card.s;
  return '<svg viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">'
    +'<rect x="1" y="1" width="98" height="138" rx="7" fill="#fdfdf8" stroke="#ccc" stroke-width="1"/>'
    +cornerSVG(rank,suit)
    +centerContentSVG(rank,suit)
    +'</svg>';
}

function svgBack(){
  return '<svg viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">'
    +'<rect x="1" y="1" width="98" height="138" rx="7" fill="#0a2218" stroke="#c8a200" stroke-width="1.5"/>'
    +'<rect x="7" y="7" width="86" height="126" rx="5" fill="none" stroke="#c8a200" stroke-width="1" opacity="0.6"/>'
    +'<g opacity="0.35" stroke="#ffd700" stroke-width="0.75">'
      +'<path d="M20 20 L50 45 L80 20 M20 120 L50 95 L80 120 M20 20 L20 120 M80 20 L80 120"/>'
      +'<path d="M50 45 L50 95"/>'
    +'</g>'
    +'<text x="50" y="72" font-size="26" text-anchor="middle" dominant-baseline="central" fill="#ffd700" opacity="0.85">⬡</text>'
    +'</svg>';
}

function rankLabel(r){return RANK_LABEL[r];}
function suitSymbol(s){return SUIT_SYMBOL[s];}
function suitColor(s){return SUIT_COLOR[s];}

// ── DOM helper: a flippable card slot ────────────────────────────────────────
// makeSlot() returns a detached .pc-card element with back showing. setFront()
// populates its face content (call once cards are known). flipUp() animates
// back->front. reset() clears it back to a blank face-down slot for a new hand.
function makeSlot(){
  const el=document.createElement('div');
  el.className='pc-card';
  el.innerHTML='<div class="pc-card-inner"><div class="pc-face pc-back">'+svgBack()+'</div><div class="pc-face pc-front"></div></div>';
  return el;
}
function setFront(el,card){
  const front=el.querySelector('.pc-front');
  if(front)front.innerHTML=svgFront(card);
}
function flipUp(el){el.classList.add('flipped');}
function reset(el){
  el.classList.remove('flipped');
  const front=el.querySelector('.pc-front');
  if(front)front.innerHTML='';
}

function injectStyle(){
  if(document.getElementById('pc-style'))return;
  const s=document.createElement('style');
  s.id='pc-style';
  s.textContent=
    '.pc-card{width:var(--pc-w,60px);height:calc(var(--pc-w,60px)*1.4);perspective:600px;flex-shrink:0}'+
    '.pc-card-inner{position:relative;width:100%;height:100%;transition:transform .5s cubic-bezier(.4,.2,.2,1);transform-style:preserve-3d}'+
    '.pc-card.flipped .pc-card-inner{transform:rotateY(180deg)}'+
    '.pc-face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border-radius:8%;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,.45)}'+
    '.pc-front{transform:rotateY(180deg)}'+
    '.pc-card.empty .pc-face{visibility:hidden}';
  document.head.appendChild(s);
}
injectStyle();

window.Cards={svgFront,svgBack,makeSlot,setFront,flipUp,reset,rankLabel,suitSymbol,suitColor};
})();
