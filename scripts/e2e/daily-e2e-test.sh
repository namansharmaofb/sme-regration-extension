#!/bin/bash
set -e

# ==============================================================================
# Daily E2E Test Orchestrator
# Phases: Setup -> Signup -> Onboarding -> Feature Tests
#
# USAGE:
#   ./daily-e2e-test.sh              # Full run with cleanup
#   SKIP_CLEANUP=1 ./daily-e2e-test.sh  # Skip cleanup, use existing session
# ==============================================================================

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
E2E_DIR="$PROJECT_ROOT/scripts/e2e"

# Default to skipping cleanup to preserve persistent Chrome session
SKIP_CLEANUP=${SKIP_CLEANUP:-1}

if [ "$SKIP_CLEANUP" = "0" ]; then
    echo "=============================================================================="
    echo "PHASE 1: SETUP (CLEANUP REQUESTED)"
    echo "Killing lingering Chrome instances and cleaning up test user..."
    echo "=============================================================================="

    # 1. Kill Chrome (Linux/Mac)
    pkill -f "chrome" || echo "No Chrome processes found."

    # 2. Run Cleanup Script
    echo "Running cleanup for test user..."
    node "$E2E_DIR/delete-test-user.js"
else
    echo "=============================================================================="
    echo "PHASE 1: SETUP (PRESERVE SESSION)"
    echo "SKIP_CLEANUP=1 is set (default). Preserving Chrome session and cookies."
    echo "=============================================================================="
fi

echo "=============================================================================="
echo "PHASE 2: LOGIN, ONBOARDING & FEATURE TESTS"
echo "Starting Runner to handle Login, Onboarding and Feature Tests..."
echo "=============================================================================="

# 3. Run the main Puppeteer runner
# The runner handles phases 2 and 3 internally
node "$E2E_DIR/runner.js" | tee "$E2E_DIR/runner.log"

echo "=============================================================================="
echo "E2E TEST COMPLETED SUCCESSFULLY"
echo "=============================================================================="
