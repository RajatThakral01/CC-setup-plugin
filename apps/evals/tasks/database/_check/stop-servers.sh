#!/usr/bin/env bash
# Stops servers the agent may have left running, so checks always test a fresh build.
pkill -f 'next dev' 2>/dev/null || true
pkill -f 'next start' 2>/dev/null || true
pkill -f 'next-server' 2>/dev/null || true
sleep 1
