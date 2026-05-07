# Repository Guidelines

## Project Structure & Module Organization
This repository is a zero-bundler static web app. Keep the structure flat:

- `index.html`: page shell, inline CSS, import map, and UI markup.
- `src/main.js`: Three.js scene setup, cloth simulation, UI state, and modal logic.
- `Justfile`: local developer commands.
- `flake.nix` and `.envrc`: Nix-based dev environment.
- `guidelines`: design notes and product context; treat as reference, not runtime code.

There is no `tests/` directory or build output folder at the moment.

## Build, Test, and Development Commands
Run development tasks from the repository root.

- `nix develop`: enter the shell that provides `live-server` and `just`.
- `just dev`: serve the app at `http://localhost:8080` with live reload.
- `just refresh`: force a reload by touching `index.html`.
- `just check`: verify the local toolchain versions.

Because the app is served directly from source files, there is no bundling or production build step.

## Coding Style & Naming Conventions
Use 2-space indentation in HTML, CSS, and JavaScript. Prefer small, readable changes over large refactors in `src/main.js`, which currently owns most runtime behavior.

Follow the existing naming patterns:

- `camelCase` for variables and functions, for example `buildCloth` and `updateDropBtn`.
- `UPPER_SNAKE_CASE` for simulation constants such as `CLOTH_SIZE`.
- Descriptive DOM ids like `btn-drop`, `math-modal`, and `eigen-popup`.

Preserve the existing Nord palette and keep UI styling in `index.html` unless the project is restructured intentionally.

## Testing Guidelines
There is no automated test suite yet. Validate changes manually in the browser through `just dev`.

Check at least:

- canvas rendering and resize behavior
- control-panel interactions
- simulation state changes such as `Drop`, `Pause`, `Resume`, and `Reset`
- modal and language-toggle flows if touched

If you add automated tests later, place them in a new `tests/` directory and document the command here.

## Commit & Pull Request Guidelines
Recent history uses short Conventional Commit-style prefixes such as `feat:` and `ui:`. Keep commits focused and imperative, for example `feat: add verlet popup controls`.

Pull requests should include:

- a brief summary of the user-visible change
- linked issue or task context when available
- screenshots or short recordings for UI changes
- manual verification notes describing what was tested locally
