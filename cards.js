// cards.js — shared playing-card renderer + flip-slot DOM helper.
// Self-contained (injects its own <style>), following the cloche-dice.js/winner-modal.js
// convention: copy into a new game's root as-is, no build step required beyond the
// cards/ image folder sitting alongside it.
//
// Card art: original, made by Deck -- no external license. Faces/back are pre-rendered
// PNGs (cards/card-<RANK><SUIT>.png, cards/card-back.png), not generated here.
(function(){

const RANK_CODE={14:'A',13:'K',12:'Q',11:'J',10:'10',9:'9',8:'8',7:'7',6:'6',5:'5',4:'4',3:'3',2:'2'};
const RANK_LABEL=RANK_CODE;
const SUIT_SYMBOL={S:'♠',H:'♥',D:'♦',C:'♣'};
const SUIT_COLOR={S:'#161616',C:'#161616',H:'#c41230',D:'#c41230'};

// Bump alongside cards.js?v= in every host page whenever the card art itself changes --
// the images keep the same filenames, so without a cache-busting query string GitHub Pages
// would keep serving the old cached PNGs for a while after a deploy.
const CARD_ASSET_V='0.4.120';
function cardImgSrc(card){return 'cards/card-'+RANK_CODE[card.r]+card.s+'.png?v='+CARD_ASSET_V;}
function backImgSrc(){return 'cards/card-back.png?v='+CARD_ASSET_V;}

function rankLabel(r){return RANK_LABEL[r];}
function suitSymbol(s){return SUIT_SYMBOL[s];}
function suitColor(s){return SUIT_COLOR[s];}

// Warms the browser's image cache for every card face (+ the back) up front, so a
// mid-hand reveal never has to kick off a fresh network fetch + decode for a face
// it's about to paint -- that decode work landing on the main thread mid-animation
// is what turns a staggered reveal into a stall-then-snap on slower mobile devices.
// Safe to call multiple times; the browser cache makes repeats free. Callers should
// fire this once, as early as possible (page load), well before the first deal.
function preloadAll(){
  Object.keys(RANK_CODE).forEach(r=>{
    ['S','H','D','C'].forEach(s=>{
      const img=new Image();
      img.src=cardImgSrc({r:+r,s});
    });
  });
  const back=new Image();
  back.src=backImgSrc();
}

// ── DOM helper: a flippable card slot ────────────────────────────────────────
// makeSlot() returns a detached .pc-card element with back showing. setFront()
// populates its face content (call once cards are known). flipUp() animates
// back->front. reset() clears it back to a blank face-down slot for a new hand.
function makeSlot(){
  const el=document.createElement('div');
  el.className='pc-card';
  el.innerHTML='<div class="pc-card-inner">'
    +'<div class="pc-face pc-back"><img src="'+backImgSrc()+'" alt="" draggable="false"></div>'
    +'<div class="pc-face pc-front"><img alt="" draggable="false"></div>'
    +'</div>';
  return el;
}
function setFront(el,card){
  const img=el.querySelector('.pc-front img');
  if(img)img.src=cardImgSrc(card);
}
function flipUp(el){el.classList.add('flipped');}
function reset(el){
  el.classList.remove('flipped','deal-in');
  el.style.animationDelay='';
  const img=el.querySelector('.pc-front img');
  if(img)img.removeAttribute('src');
}

// dealIn(el, delayMs): plays the "card slides/pops into place" animation, staggered by
// delayMs. Re-triggerable across hands (forces a reflow so the class re-applies cleanly
// even if the element already carries it from a previous deal).
function dealIn(el,delayMs){
  el.classList.remove('deal-in');
  void el.offsetWidth;
  el.style.animationDelay=(delayMs||0)+'ms';
  el.classList.add('deal-in');
}

function injectStyle(){
  if(document.getElementById('pc-style'))return;
  const s=document.createElement('style');
  s.id='pc-style';
  s.textContent=
    // Card art is 750x1050 (a true 2.5x3.5in card, h/w=1.4 exactly) with a baked-in circular
    // corner radius measured at ~6.2% of width (750x1050 -> ~46.5px radius). border-radius here
    // is deliberately calc()'d off --pc-w alone (not a plain "%", which is independently
    // percent-of-width horizontally and percent-of-height vertically -- on this non-square box
    // that draws an ellipse, not the circle the art actually has) so both radii stay true
    // circles that track the art's corner curve at any card size.
    '.pc-card{width:var(--pc-w,60px);height:calc(var(--pc-w,60px)*1.4);perspective:600px;flex-shrink:0}'+
    '.pc-card-inner{position:relative;width:100%;height:100%;transition:transform .5s cubic-bezier(.4,.2,.2,1);transform-style:preserve-3d}'+
    '.pc-card.flipped .pc-card-inner{transform:rotateY(180deg)}'+
    '.pc-face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border-radius:calc(var(--pc-w,60px)*.062);overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,.45);background:#fff}'+
    '.pc-face img{display:block;width:100%;height:100%;object-fit:contain;-webkit-user-drag:none;user-drag:none}'+
    '.pc-front{transform:rotateY(180deg)}'+
    '.pc-card.empty .pc-face{visibility:hidden}'+
    '@keyframes pc-deal-in{from{opacity:0;transform:translateY(-30px) scale(.78)}to{opacity:1;transform:translateY(0) scale(1)}}'+
    '.pc-card.deal-in{animation:pc-deal-in .4s cubic-bezier(.25,.7,.3,1) both}';
  document.head.appendChild(s);
}
injectStyle();

window.Cards={makeSlot,setFront,flipUp,reset,dealIn,rankLabel,suitSymbol,suitColor,cardImgSrc,backImgSrc,preloadAll};
})();
