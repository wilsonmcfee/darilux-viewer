/* ============================================================================
   disclaimer.ts — client-facing "About this demo" copy (DRAFT for review).
   ----------------------------------------------------------------------------
   This is the disclaimer shown in the modal. It is a DRAFT — the same wording
   lives in DISCLAIMER-DRAFT.md at the project root for easy editing/review.
   Keep the two in sync (or replace this with your final approved wording).
   ========================================================================== */

export const DISCLAIMER_HTML = `
  <h2 id="disclaimer-title">About this demo</h2>
  <p>
    This is an early, private preview of interactive 3D capture — a technique
    called <strong>Gaussian splatting</strong> that turns real spaces into
    something you can explore in your browser, no app or plugin required.
    It's built to show what's possible; it is not a finished, color-graded
    delivery.
  </p>

  <h3>For the best experience</h3>
  <p>
    Open this link <strong>directly in Chrome or Safari</strong> on a recent
    laptop, desktop, or phone. Opening it from inside a chat or social app
    (the in-app browser) can prevent it from rendering. A modern graphics-
    capable device gives the smoothest result.
  </p>

  <h3>Loading &amp; performance</h3>
  <p>
    Each scene streams in as you open it and can be a sizeable download, so the
    first few seconds may show a loading indicator — especially on the larger
    rooms and over mobile data. Only one scene loads at a time to keep things
    responsive.
  </p>

  <h3>What you're looking at</h3>
  <p>
    These are reconstructions grown from video, not photographs. Some softness
    or stray points ("floaters") are normal at this stage and are exactly the
    kind of thing refined in a final capture. The larger common-room scene is a
    <strong>composite of two captures</strong>, included to show how fidelity
    holds across a bigger space.
  </p>

  <p style="margin-top:18px;opacity:0.8;">
    Shared in confidence with Just&nbsp;For&nbsp;The&nbsp;Record. Please don't
    redistribute. — Morisot&nbsp;Studio
  </p>
`;
