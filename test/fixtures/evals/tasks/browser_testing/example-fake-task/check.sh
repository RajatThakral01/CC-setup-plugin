#!/usr/bin/env bash
# Passes when the agent ran and the hidden files arrived; prints what the fake agent saw.
set -euo pipefail
test -f /home/node/.eval-check/hidden.txt
cat /home/node/agent-was-here
