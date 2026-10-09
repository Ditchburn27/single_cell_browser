// Allen Mouse Brain Atlas in-situ hybridisation viewer. Offered only for mouse-like gene symbols.
// Images are fetched on demand (nothing embedded); if the browser can't reach the API we link out instead.
import type { Plugin } from './registry';

const API = 'https://api.brain-map.org/api/v2';

export const allenIsh: Plugin = {
  id: 'allen-ish',
  title: 'Allen ISH (mouse)',
  applies: (app) => app.ds.meta.species === 'mouse',
  mount(app, host) {
    host.innerHTML = `<div style="padding:8px 10px;border-bottom:1px solid var(--bord);font-size:12px;display:flex;justify-content:space-between;align-items:center"><b>Allen ISH</b><a id="allen-link" target="_blank" rel="noopener" style="font-size:11px;color:var(--acc)">Open Allen Atlas ↗</a></div>
      <div id="allen-body" style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;background:#0d0d0d;color:#999;font-size:12px;text-align:center;padding:10px"></div>`;
    const body = host.querySelector<HTMLElement>('#allen-body')!, link = host.querySelector<HTMLAnchorElement>('#allen-link')!;
    let token = 0;
    return {
      async onGene(gene) {
        const my = ++token;
        if (!gene) { body.textContent = 'Select a gene'; return; }
        link.href = `https://mouse.brain-map.org/search/show?search_type=gene&search_term=${encodeURIComponent(gene)}`;
        body.textContent = `Looking up ${gene}…`;
        try {
          const q = `${API}/data/query.json?criteria=model::SectionDataSet,rma::criteria,products[id$eq1],genes[acronym$eq'${encodeURIComponent(gene)}'],rma::include,section_images`;
          const r = await fetch(q); const j = await r.json();
          if (my !== token) return;
          type DS = { plane_of_section_id: number; section_images?: { id: number }[] };
          const sets = ((j?.msg ?? []) as DS[]).filter((d) => d.section_images?.length);
          const ds = sets.find((d) => d.plane_of_section_id === 1) ?? sets[0]; // prefer coronal
          if (!ds) { body.textContent = `No ISH data for ${gene}.`; return; }
          const imgs = ds.section_images!, mid = imgs[Math.floor(imgs.length / 2)];
          body.innerHTML = `<img alt="ISH ${gene}" src="${API}/image_download/${mid.id}?downsample=3" style="max-width:100%;max-height:100%;object-fit:contain">`;
        } catch {
          if (my === token) body.innerHTML = `Couldn't reach the Allen API from this browser.<br><a href="${link.href}" target="_blank" rel="noopener" style="color:#8fa4ff">Open ${gene} on the Allen Atlas ↗</a>`;
        }
      },
      destroy() { token++; host.innerHTML = ''; },
    };
  },
};
