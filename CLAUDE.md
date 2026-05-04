# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
just dev      # Start live-server on http://localhost:8080 (auto-reloads on file save)
just refresh  # Force a live-server reload by touching index.html
just check    # Verify live-server and just versions
```

Enter the dev shell first: `nix develop` (or let direnv do it automatically via `.envrc`).

No build step — the app is served as static files directly from the project root.

## Architecture

This is a **zero-bundler, single-page static web app**. All source lives in two files:

- `index.html` — entire CSS (Nord palette vars, layout, component styles) + HTML structure
- `src/main.js` — all JavaScript: Three.js scene setup, physics simulation, UI event handlers, modal copy

External dependencies are loaded via **CDN import maps** (no `node_modules`, no bundler):
- `three@0.163.0` — 3D renderer + OrbitControls
- `katex@0.16.9` — math formula rendering in the modal
- `prismjs@1.29.0` (Nord theme) — syntax highlighting in the modal

## Physics simulation (`src/main.js`)

The cloth is a mass-spring system solved with **Verlet integration** and sub-stepping (`SUBSTEPS = 8`).

Key data structures (rebuilt on resolution change via `buildCloth(res)`):
- `positions: Float32Array` — flat `[x,y,z, ...]` for all `N = (res+1)²` vertices
- `prevPos: Float32Array` — previous frame positions (used by Verlet)
- `pinned: Boolean[]` — per-vertex pin flag (currently unused but wired in)

Simulation states: `idle → falling → settled`. Settled detection compares mean-Y delta between frames.

Constraint solving order per substep: gravity + Verlet → structural springs → diagonal shear springs → sphere vertex collision → segment-sphere collision (`solveEdgeSphere`) → ground floor clamp.

The **Eigen-Spectrum** bars are an analytic approximation, not computed from a real matrix decomposition:
$$\lambda_k \approx 4s \sin^2\!\left(\frac{k\pi}{2N}\right)$$

## UI layout

```
Header (fixed)
├── Viewport (#viewport) — Three.js canvas fills remaining space
└── Right panel (#panel, 230px) — glassmorphism, backdrop-filter blur
    ├── Topology: segmented control → calls buildCloth(res)
    ├── Material Preset: Soft/Medium/Stiff → changes PRESETS[preset]
    ├── Experiment Actions: Reset / Drop / Jitter
    ├── Visualisation: Stress Heatmap toggle (vertex colors)
    └── Math Monitor: vertex count, matrix dim, FPS, eigen-spectrum bars
Status bar (fixed footer)
Math modal (fixed overlay, hidden by default) — bilingual EN/中文
```

## Color system

All colors use Nord palette CSS variables (`--nord0` through `--nord15`) defined in `index.html`. Do not hardcode hex values in JS or CSS — reference the variables or use the constants already in the JS (e.g., `0x88C0D0` = Nord8, `0x2E3440` = Nord0).
