// Optional, dataset-gated side panels. A plugin is only offered when `applies(app)` is true for the loaded data.
import type { App } from '../app';
import { allenIsh } from './allen-ish';

export interface Plugin {
  id: string;
  title: string;
  applies(app: App): boolean;
  /** Create the panel inside `host`; return handlers. */
  mount(app: App, host: HTMLElement): { onGene(gene: string | null): void; destroy(): void };
}

const PLUGINS: Plugin[] = [allenIsh];
let active: { id: string; pane: HTMLElement; inst: ReturnType<Plugin['mount']>; btn: HTMLElement }[] = [];

export function mount(app: App) {
  for (const a of active) { a.inst.destroy(); a.pane.remove(); }
  active = [];
  const nav = document.getElementById('plugin-nav')!; nav.innerHTML = '';
  for (const p of PLUGINS) {
    if (!p.applies(app)) continue;
    const btn = document.createElement('button'); btn.className = 'hbtn'; btn.textContent = p.title;
    let entry: (typeof active)[number] | null = null;
    btn.onclick = () => {
      if (entry) { entry.inst.destroy(); entry.pane.remove(); active = active.filter((x) => x !== entry); entry = null; btn.classList.remove('on'); }
      else {
        const pane = document.createElement('div'); pane.className = 'plugin-pane'; document.getElementById('umaps')!.appendChild(pane);
        const inst = p.mount(app, pane); entry = { id: p.id, pane, inst, btn }; active.push(entry); btn.classList.add('on'); inst.onGene(app.gene);
      }
      app.panes.forEach((q) => q.sizeChanged());
    };
    nav.appendChild(btn);
  }
  app.onGeneChanged.push(() => active.forEach((a) => a.inst.onGene(app.gene)));
}
