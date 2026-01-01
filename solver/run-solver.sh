#!/bin/bash
# Run solver with suppressed Aztec logs
LOG_LEVEL=fatal AZTEC_LOG_LEVEL=fatal npx tsx solver.ts 2>&1 | grep -v "pxe:service"
