// Instant, themed tooltips.
//
// The app annotates its controls with `title`, but the browser waits roughly a second of
// motionless hovering before drawing anything, and styles it as an OS tooltip rather than
// in the app's own theme — long enough that most people never see it. This moves each
// title to `data-tip` on first hover (so the native tooltip never fires) and draws our own.
//
// Delegated from `document`, so controls created later — the dock panels, plugin buttons —
// are covered without registering anything per element.

const DELAY_MS = 180;

export function initTooltips(): void {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);

  let timer: number | undefined;
  let current: HTMLElement | null = null;

  const hide = () => { window.clearTimeout(timer); current = null; tip.hidden = true; };

  const place = (el: HTMLElement) => {
    tip.hidden = false;                       // must be laid out before it can be measured
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect(), gap = 6;
    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(gap, Math.min(left, window.innerWidth - t.width - gap));
    let top = r.bottom + gap;
    if (top + t.height > window.innerHeight - gap) top = r.top - t.height - gap;   // flip above
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(Math.max(gap, top))}px`;
  };

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;    // touch devices get the Help overlay instead
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[title],[data-tip]');
    if (!el || el === current) return;
    const text = (el.getAttribute('data-tip') ?? el.getAttribute('title') ?? '').trim();
    if (!text) return;
    if (el.hasAttribute('title')) { el.setAttribute('data-tip', text); el.removeAttribute('title'); }
    current = el;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { tip.textContent = text; place(el); }, DELAY_MS);
  });

  document.addEventListener('pointerout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (current && (!to || !current.contains(to))) hide();
  });
  document.addEventListener('pointerdown', hide);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); }, true);
}
