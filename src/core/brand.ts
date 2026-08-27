/* ============================================================================
   brand.ts — the viewer's brand identity, injected by the deployment.
   ----------------------------------------------------------------------------
   The engine never hardcodes a studio or client name. The entry module calls
   setBrand() with the deployment's identity (today: the BRAND block in
   demos.ts; after the core extraction: an option on createViewer()). Anything
   brand-flavoured — console log prefixes, the disclaimer signature — reads
   from here, so the engine files stay free of client strings.
   ========================================================================== */

export interface Brand {
  /** Display name, e.g. the disclaimer signature. */
  name: string;
  /** Short lowercase tag used as the console log prefix. */
  tag: string;
}

let brand: Brand = { name: 'Viewer', tag: 'viewer' };

export function setBrand(b: Brand): void {
  brand = b;
}

export function brandName(): string {
  return brand.name;
}

/** Console log prefix, e.g. `[viewer]`. */
export function logTag(): string {
  return `[${brand.tag}]`;
}
