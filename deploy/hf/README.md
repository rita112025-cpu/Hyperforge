---
title: HyperForge
emoji: ⚗️
colorFrom: purple
colorTo: indigo
sdk: static
app_build_command: npm run build:hf
app_file: out/index.html
fullWidth: true
short_description: Browser-only knowledge graphs and semantic indexing
---

# HyperForge

Local-first knowledge forge: documents, knowledge graphs, semantic indexing,
summaries, mind maps, slides, and structured outputs run in your browser.

Source of truth: https://github.com/rita112025-cpu/Hyperforge

This README replaces the GitHub README only in the derived Space repository.
Deploy the same source revision and lockfile; include the existing multilingual
MiniLM model under `public/models/` and ORT WASM under `public/ort/`.
The runtime loads these assets from this Space, without remote inference APIs.
Browser data is stored in IndexedDB for this origin.

Build with Node.js 20 or 22 and `npm ci` followed by `npm run build:hf`.
The GitHub repository ignores the model files, so a source-only copy is not a
complete deployment. Never include tokens in source or build artifacts.
