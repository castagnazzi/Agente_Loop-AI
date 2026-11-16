// Arrastar por IPC (em vez de -webkit-app-region) para que o clique continue
// chegando ao renderer. Movimento < 4px = clique; acima disso = arraste.
const el = document.getElementById('pet');
let start = null, moved = false;

el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  el.setPointerCapture(e.pointerId);
  start = { x: e.screenX, y: e.screenY };
  moved = false;
  window.loop.dragStart();
});
el.addEventListener('pointermove', (e) => {
  if (!start) return;
  const dx = e.screenX - start.x, dy = e.screenY - start.y;
  if (!moved && Math.hypot(dx, dy) < 4) return;
  moved = true;
  el.classList.add('dragging');
  window.loop.dragMove(dx, dy);
});
el.addEventListener('pointerup', () => {
  if (!start) return;
  start = null;
  el.classList.remove('dragging');
  window.loop.dragEnd();
  if (!moved) window.loop.petClick();
});
el.addEventListener('contextmenu', (e) => { e.preventDefault(); window.loop.petMenu(); });
window.loop.onEvent((ev) => { if (ev.type === 'busy') el.classList.toggle('busy', ev.value); });

// scroll do mouse sobre o boneco: aumenta/diminui
el.addEventListener('wheel', (e) => { e.preventDefault(); window.loop.petWheel(e.deltaY); }, { passive: false });
