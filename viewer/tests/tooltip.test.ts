// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initTooltips } from '../src/ui/tooltip';

function hover(el: Element, pointerType = 'mouse') {
  const e = new MouseEvent('pointerover', { bubbles: true });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  el.dispatchEvent(e);
}
function leave(el: Element, to: Node | null = null) {
  const e = new MouseEvent('pointerout', { bubbles: true });
  Object.defineProperty(e, 'relatedTarget', { value: to });
  el.dispatchEvent(e);
}
const tipEl = () => document.querySelector('.tip') as HTMLElement;

describe('tooltips', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="a" title="Explains A">A</button><button id="b">B</button>';
    initTooltips();
  });

  it('shows the title text after a short delay, not immediately', () => {
    const a = document.getElementById('a')!;
    hover(a);
    expect(tipEl().hidden).toBe(true);          // nothing on the very first frame
    vi.advanceTimersByTime(200);
    expect(tipEl().hidden).toBe(false);
    expect(tipEl().textContent).toBe('Explains A');
  });

  it('suppresses the native tooltip by moving title to data-tip', () => {
    const a = document.getElementById('a')!;
    hover(a);
    expect(a.hasAttribute('title')).toBe(false);
    expect(a.getAttribute('data-tip')).toBe('Explains A');
    vi.advanceTimersByTime(200);
    expect(tipEl().textContent).toBe('Explains A');
  });

  it('still works on a second hover, once the title has been moved', () => {
    const a = document.getElementById('a')!;
    hover(a); vi.advanceTimersByTime(200); leave(a);
    expect(tipEl().hidden).toBe(true);
    hover(a); vi.advanceTimersByTime(200);
    expect(tipEl().textContent).toBe('Explains A');
  });

  it('hides when the pointer leaves, and on Escape or a click', () => {
    const a = document.getElementById('a')!;
    hover(a); vi.advanceTimersByTime(200); leave(a);
    expect(tipEl().hidden).toBe(true);

    hover(a); vi.advanceTimersByTime(200);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tipEl().hidden).toBe(true);

    hover(a); vi.advanceTimersByTime(200);
    document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(tipEl().hidden).toBe(true);
  });

  it('ignores touch, which has no hover and gets the Help overlay instead', () => {
    hover(document.getElementById('a')!, 'touch');
    vi.advanceTimersByTime(200);
    expect(tipEl().hidden).toBe(true);
  });

  it('ignores controls with no title', () => {
    hover(document.getElementById('b')!);
    vi.advanceTimersByTime(200);
    expect(tipEl().hidden).toBe(true);
  });
});
