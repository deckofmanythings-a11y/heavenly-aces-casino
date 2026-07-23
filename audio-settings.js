// Shared, site-wide sound volume/mute -- one localStorage-backed setting read by every
// game's own playChipSound()/playSfx()/etc (each game still owns its own Audio() objects
// and playback timing; this only supplies the volume multiplier). Loaded early on every
// page so window.AudioSettings exists before any gameplay code could try to play a sound.
(function(global){
  const KEY='rh_audio_settings';
  const state={volume:1,muted:false};
  try{
    const raw=JSON.parse(global.localStorage.getItem(KEY));
    if(raw&&typeof raw==='object'){
      if(typeof raw.volume==='number')state.volume=Math.max(0,Math.min(1,raw.volume));
      if(typeof raw.muted==='boolean')state.muted=raw.muted;
    }
  }catch(e){}
  function save(){try{global.localStorage.setItem(KEY,JSON.stringify(state));}catch(e){}}
  const listeners=[];
  function notify(){listeners.forEach(fn=>{try{fn(AudioSettings.effectiveVolume(),state.muted);}catch(e){}});}
  const AudioSettings={
    getVolume(){return state.volume;},
    isMuted(){return state.muted;},
    // What a game should actually multiply a clip's own base volume by -- 0 while muted
    // regardless of the stored volume level, so games never need their own separate mute check.
    effectiveVolume(){return state.muted?0:state.volume;},
    setVolume(v){state.volume=Math.max(0,Math.min(1,v));save();notify();},
    setMuted(m){state.muted=!!m;save();notify();},
    // For a settings UI (e.g. the lobby's Options modal) to live-update its own controls if
    // changed elsewhere -- no page currently does this from two places at once, but cheap
    // to support and avoids a stale slider if that ever changes.
    onChange(fn){if(typeof fn==='function')listeners.push(fn);},
  };
  global.AudioSettings=AudioSettings;
})(window);
