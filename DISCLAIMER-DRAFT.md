# About this demo (client-facing copy)

> Source of truth for the "About this demo" modal. The live version is in
> `src/disclaimer.ts` — keep the two in sync.

This is an early preview of what will be a custom, interactive 3D viewer of
Just For The Record's studio spaces, rooms and featured gear, using a technique
called **Gaussian splatting**. This method turns real spaces into something you
can explore in your browser using a custom rendering engine — no app or plugin
required. It's built to show what's possible, and known issues are explored
below.

## Loading & performance

Each scene streams in as you open it and can be a sizeable download (although
less than 50 MB), so the first few seconds may show a loading indicator —
especially on the larger rooms and over mobile data. Only one scene loads at a
time to keep things responsive.

## What you're looking at

These are reconstructions grown from video, not photographs or LiDAR. Some
softness or stray points ("floaters") are normal at this stage and are exactly
the kind of thing refined in a final capture. The captures are separated into
three different sizes — **medium, large, and small scale** — to demonstrate
different use cases. One of the advantages of Gaussian splatting specifically
is that detail translates equally between larger and smaller scale scans,
meaning you don't have to sacrifice fidelity just because you're capturing a
large space. When captured with a 'prosumer' grade camera (Sony ZV-E1), capture
quality is much higher than an iPhone (what was used for this demo) and the
resulting 3D model will also be much higher quality.

## For the best experience

Open this link **directly in Chrome or Safari** on a recent laptop or desktop.
This demo also runs on mobile, but with limited methods of movement — the final
product will address this. A modern graphics-capable device gives the smoothest
result.

**Have fun!**

*Shared in confidence with Just For The Record. Please don't redistribute. —
Darilux Studio*
