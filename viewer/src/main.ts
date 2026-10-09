import './style.css';
import { App } from './app';

const app = new App();
(window as unknown as { app: App }).app = app; // handy for debugging in the console

const input = document.getElementById('file-input') as HTMLInputElement;
input.addEventListener('change', () => { const f = input.files?.[0]; if (f) app.open(f); input.value = ''; });

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
