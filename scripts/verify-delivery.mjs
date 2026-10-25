#!/usr/bin/env node

// Local delivery gate for repositories whose generated artifacts fan out across
// a gallery, an archive and a README proof. The stage order and files live in
// scripts/delivery-manifest.json; this runner deliberately knows nothing about
// archify's renderers, so the same runner can be copied to another project with
// its own manifest.
//
// Usage:
//   node scripts/verify-delivery.mjs
//   node scripts/verify-delivery.mjs --skip-browser
//   node scripts/verify-delivery.mjs --only=viewer,gallery --dry-run
//   ARCHIFY_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg@6/bin node scripts/verify-delivery.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  return `Usage: node scripts/verify-delivery.mjs [options]

Runs the stages in scripts/delivery-manifest.json in order, then verifies that
each receipt still matches the artifact bytes it claims to describe.

Options:
  --config <file>       manifest path (default: scripts/delivery-manifest.json)
  --only <ids>          run only these comma-separated stage ids
  --skip <ids>          skip these comma-separated stage ids
  --skip-browser        shorthand for --skip=browser
  --ffmpeg-path <dir>   prepend a directory to PATH for the README stage
                        (also accepted as ARCHIFY_FFMPEG_PATH)
  --dry-run             print commands without executing them
  --list                list stages and exit
  --help                show this message

The runner stops at the first failed stage unless --keep-going is supplied.
`;
}

function parseOptions(argv) {
  const options = {
    config: 'scripts/delivery-manifest.json',
    only: null,
    skip: new Set(),
    dryRun: false,
    list: false,
    keepGoing: false,
    help: false,
    ffmpegPath: process.env.ARCHIFY_FFMPEG_PATH || '',
  };

  const readOption = (index, arg, name) => {
    if (arg === name) {
      if (index + 1 >= argv.length) throw new Error(`${name} requires a value`);
      return { value: argv[index + 1], nextIndex: index + 1 };
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1);
      if (!value) throw new Error(`${name} requires a value`);
      return { value, nextIndex: index };
    }
    return null;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--list') {
      options.list = true;
      continue;
    }
    if (arg === '--keep-going') {
      options.keepGoing = true;
      continue;
    }
    if (arg === '--skip-browser') {
      options.skip.add('browser');
      continue;
    }

    const config = readOption(index, arg, '--config');
    if (config) {
      options.config = config.value;
      index = config.nextIndex;
      continue;
    }
    const only = readOption(index, arg, '--only');
    if (only) {
      options.only = new Set(only.value.split(',').filter(Boolean));
      if (options.only.size === 0) throw new Error('--only requires at least one stage id');
      index = only.nextIndex;
      continue;
    }
    const skip = readOption(index, arg, '--skip');
    if (skip) {
      for (const id of skip.value.split(',').filter(Boolean)) options.skip.add(id);
      index = skip.nextIndex;
      continue;
    }
    const ffmpegPath = readOption(index, arg, '--ffmpeg-path');
    if (ffmpegPath) {
      options.ffmpegPath = ffmpegPath.value;
      index = ffmpegPath.nextIndex;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function readManifest(options) {
  const manifestPath = path.resolve(repoRoot, options.config);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.stages)) {
    throw new Error(`${options.config}: expected a "stages" array`);
  }
  if (manifest.stages.length === 0) throw new Error(`${options.config}: no stages defined`);
  const ids = new Set(manifest.stages.map(stage => stage.id));
  for (const id of [...(options.only || []), ...options.skip]) {
    if (!ids.has(id)) throw new Error(`unknown stage id: ${id}`);
  }
  return manifest;
}

function expand(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => process.env[key] ?? '');
}

function executableFor(command) {
  if (command === 'node') return process.execPath;
  if (command === 'npm' && process.platform === 'win32') return 'npm.cmd';
  return command;
}

function stageEnvironment(stage, options) {
  const env = { ...process.env };
  if (options.ffmpegPath) {
    env.PATH = [options.ffmpegPath, env.PATH].filter(Boolean).join(path.delimiter);
  }
  for (const [key, rawValue] of Object.entries(stage.env || {})) {
    const value = expand(rawValue);
    if (key === 'PATH_PREPEND') {
      if (value) env.PATH = [value, env.PATH].filter(Boolean).join(path.delimiter);
    } else {
      env[key] = value;
    }
  }
  return env;
}

function commandLine(stage) {
  return [executableFor(stage.command), ...(stage.args || [])].join(' ');
}

function runStage(stage, options) {
  const cwd = path.resolve(repoRoot, stage.cwd || '.');
  const args = (stage.args || []).map(expand);
  if (options.dryRun) {
    console.log(`[dry-run] ${stage.label || stage.id}: ${commandLine(stage)}`);
    return { status: 'dry-run', durationMs: 0 };
  }

  console.log(`\n▶ ${stage.label || stage.id}`);
  const started = Date.now();
  const result = spawnSync(executableFor(stage.command), args, {
    cwd,
    env: stageEnvironment(stage, options),
    stdio: 'inherit',
    shell: false,
  });
  const durationMs = Date.now() - started;
  if (result.error) {
    throw new Error(`cannot start stage "${stage.id}" (${commandLine(stage)}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    throw new Error(`stage "${stage.id}" failed with ${detail} (${commandLine(stage)})`);
  }
  console.log(`✔ ${stage.label || stage.id} (${formatDuration(durationMs)})`);
  return { status: 'pass', durationMs };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verifyFreshness(entries) {
  let checks = 0;
  for (const entry of entries || []) {
    const receiptPath = path.resolve(repoRoot, entry.receipt);
    if (!fs.existsSync(receiptPath)) {
      throw new Error(`freshness "${entry.id}": receipt not found: ${entry.receipt}`);
    }
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (!Array.isArray(receipt.scenes) || receipt.scenes.length === 0) {
      throw new Error(`freshness "${entry.id}": receipt has no scenes`);
    }
    for (const scene of receipt.scenes) {
      if (!scene.artifact || !scene.artifactSha256) {
        throw new Error(`freshness "${entry.id}": scene "${scene.id || '?'}" lacks artifact/hash`);
      }
      const artifactPath = path.resolve(repoRoot, scene.artifact);
      if (!fs.existsSync(artifactPath)) {
        throw new Error(`freshness "${entry.id}": artifact not found: ${scene.artifact}`);
      }
      const actual = sha256(artifactPath);
      if (actual !== scene.artifactSha256) {
        throw new Error(
          `freshness "${entry.id}": ${scene.id} is stale\n` +
          `  expected ${scene.artifactSha256}\n` +
          `  actual   ${actual}\n` +
          `  regenerate the receipt after the final generator stage`,
        );
      }
      checks += 1;
    }
    console.log(`✔ freshness ${entry.label || entry.id} (${receipt.scenes.length} artifacts)`);
  }
  return checks;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const manifest = readManifest(options);
  const stages = manifest.stages.filter((stage) => {
    if (options.only && !options.only.has(stage.id)) return false;
    if (options.skip.has(stage.id)) return false;
    return true;
  });
  if (options.list) {
    for (const stage of stages) {
      const platform = stage.platforms ? ` [${stage.platforms.join(', ')}]` : '';
      console.log(`${stage.id}\t${stage.label || stage.id}${platform}\t${commandLine(stage)}`);
    }
    return;
  }
  if (stages.length === 0) throw new Error('no stages selected');

  const started = Date.now();
  let passed = 0;
  let skipped = 0;
  const failures = [];

  for (const stage of stages) {
    if (stage.platforms && !stage.platforms.includes(process.platform)) {
      console.log(`↷ ${stage.label || stage.id} (skipped: ${process.platform} is not supported)`);
      skipped += 1;
      continue;
    }
    try {
      const result = runStage(stage, options);
      if (result.status === 'pass' || result.status === 'dry-run') passed += 1;
    } catch (error) {
      failures.push(error.message);
      console.error(`✖ ${error.message}`);
      if (!options.keepGoing) break;
    }
  }

  if (!options.dryRun && failures.length === 0) {
    verifyFreshness(manifest.freshness);
    const elapsed = formatDuration(Date.now() - started);
    console.log(`\n✅ ${manifest.name || 'delivery verification'} passed: ${passed} stages, ${skipped} skipped, ${elapsed}.`);
    return;
  }

  if (options.dryRun) {
    console.log(`\n✅ dry run completed: ${passed} stages, ${skipped} skipped.`);
    return;
  }

  if (failures.length > 0) {
    console.error(`\n✖ ${manifest.name || 'delivery verification'} failed (${failures.length} stage${failures.length === 1 ? '' : 's'}).`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exitCode = 1;
}
