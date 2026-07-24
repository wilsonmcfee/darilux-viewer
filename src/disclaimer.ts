/* ============================================================================
   disclaimer.ts — client-facing "About this demo" copy.
   ----------------------------------------------------------------------------
   This is the disclaimer shown in the modal. The same wording lives in
   DISCLAIMER-DRAFT.md at the project root for easy editing/review.
   Keep the two in sync.
   ========================================================================== */

export const DISCLAIMER_HTML = `
  <h2 id="disclaimer-title">About this demo</h2>
  <p>
    This is an early preview of what will be a custom, interactive 3D viewer of
    Just&nbsp;For&nbsp;The&nbsp;Record's studio spaces, rooms and featured gear,
    using a technique called <strong>Gaussian splatting</strong>. This method
    turns real spaces into something you can explore in your browser using a
    custom rendering engine — no app or plugin required. It's built to show
    what's possible, and known issues are explored below.
  </p>

  <h3>Loading &amp; performance</h3>
  <p>
    Each scene streams in as you open it and can be a sizeable download
    (although less than 50&nbsp;MB), so the first few seconds may show a loading
    indicator — especially on the larger rooms and over mobile data. Only one
    scene loads at a time to keep things responsive.
  </p>

  <h3>What you're looking at</h3>
  <p>
    These are reconstructions grown from video, not photographs or LiDAR. Some
    softness or stray points ("floaters") are normal at this stage and are
    exactly the kind of thing refined in a final capture. The captures are
    separated into three different sizes — <strong>medium, large, and small
    scale</strong> — to demonstrate different use cases. One of the advantages
    of Gaussian splatting specifically is that detail translates equally
    between larger and smaller scale scans, meaning you don't have to sacrifice
    fidelity just because you're capturing a large space. When captured with a
    'prosumer' grade camera (Sony&nbsp;ZV-E1), capture quality is much higher
    than an iPhone (what was used for this demo) and the resulting 3D model
    will also be much higher quality.
  </p>

  <h3>For the best experience</h3>
  <p>
    Open this link <strong>directly in Chrome or Safari</strong> on a recent
    laptop or desktop. This demo also runs on mobile, but with limited methods
    of movement — the final product will address this. A modern
    graphics-capable device gives the smoothest result.
  </p>

  <p><strong>Have fun!</strong></p>

  <p style="margin-top:18px;opacity:0.8;">
    Shared in confidence with Just&nbsp;For&nbsp;The&nbsp;Record. Please don't
    redistribute. — Darilux&nbsp;Studio
  </p>
`;
