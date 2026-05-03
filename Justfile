set shell := ["sh", "-c"]

# List all available recipes
default:
    @just --list

# Start dev server (port 8080)
dev:
    @echo "\033[36m[Nord] Running gfx-lab dev server...\033[0m"
    live-server --port=8080 .

# Trigger live-server reload
refresh:
    @echo "\033[34m[Nord] Triggering workspace refresh...\033[0m"
    touch index.html

# Check tool versions
check:
    @live-server --version 2>&1 || true
    @just --version
