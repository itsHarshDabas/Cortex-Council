#!/usr/bin/env node
import { main } from "../scripts/gateway.mjs";

main().catch((err) => {
  console.error(`  ✖ ${err.message}`);
  process.exitCode = 1;
});
