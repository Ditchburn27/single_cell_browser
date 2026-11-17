import './style.css';
import { App } from './app';

const app = new App();
(window as unknown as { app: App }).app = app; // handy for debugging in the console

const input = document.getElementById('file-input') as HTMLInputElement;
input.addEventListener('change', () => { const f = input.files?.[0]; if (f) app.open(f); input.value = ''; });

// ?data=<url> — open a hosted .scb directly, so a link behaves like the old Shiny URL.
// Relative paths are resolved against this page; a cross-origin URL additionally needs that
// origin added to connect-src in public/_headers.
const dataUrl = new URLSearchParams(location.search).get('data');
if (dataUrl) {
  document.getElementById('welcome')!.hidden = true;
  app.open({ url: dataUrl }).catch(() => { document.getElementById('welcome')!.hidden = false; });
}

// drag & drop anywhere
const veil = document.getElementById('dropveil')!;
let depth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; veil.hidden = false; } });
window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) veil.hidden = true; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); depth = 0; veil.hidden = true;
  const f = e.dataTransfer?.files?.[0]; if (f) app.open(f);
});

// help overlay — reachable from the welcome card and from the header while a dataset is open
const help = document.getElementById('help')!;
const showHelp = (on: boolean) => { help.hidden = !on; };
document.getElementById('helpbtn')!.addEventListener('click', () => showHelp(true));
document.getElementById('help-link')!.addEventListener('click', (e) => { e.preventDefault(); showHelp(true); });
document.getElementById('help-close')!.addEventListener('click', () => showHelp(false));
help.addEventListener('click', (e) => { if (e.target === help) showHelp(false); });
// capture phase: when the overlay is open Esc closes it and must not also clear the selection
document.addEventListener('keydown', (e) => {
  const typing = (e.target as HTMLElement).matches('input,textarea,select');
  if (e.key === 'Escape' && !help.hidden) { e.stopPropagation(); showHelp(false); }
  else if (e.key === '?' && help.hidden && !typing) { e.preventDefault(); showHelp(true); }
}, true);
