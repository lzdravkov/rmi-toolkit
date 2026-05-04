import { execSync, spawnSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TARGET_ORG = process.env.SF_TARGET_ORG || 'iewc-mfg-rca';

/**
 * Run a SOQL query against the target org.
 * Returns an array of record objects.
 */
export function query(soql) {
  const result = execSync(
    `sf data query --target-org "${TARGET_ORG}" --query "${soql.replace(/"/g, '\\"')}" --result-format json`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const parsed = JSON.parse(result);
  return parsed.result?.records ?? [];
}

/**
 * Execute an anonymous Apex string against the target org.
 * Returns the raw output string.
 * Throws if the execution reports a compile or runtime error.
 */
export function runApex(apexCode) {
  const tmpFile = join(tmpdir(), `rmi_apex_${Date.now()}.apex`);
  try {
    writeFileSync(tmpFile, apexCode, 'utf8');
    const result = spawnSync(
      'sf',
      ['apex', 'run', '--target-org', TARGET_ORG, '--file', tmpFile],
      { encoding: 'utf8' }
    );
    const output = result.stdout + result.stderr;
    if (result.status !== 0) {
      throw new Error(`Apex execution failed:\n${output}`);
    }
    if (output.includes('COMPILE ERROR') || /System\.\w+Exception/.test(output)) {
      throw new Error(`Apex error:\n${output}`);
    }
    return output;
  } finally {
    try { unlinkSync(tmpFile); } catch (_) {}
  }
}

/**
 * Extract a debug log value from Apex output.
 * Looks for lines matching: DEBUG|<key>|<value>
 */
export function extractDebugValue(output, key) {
  const lines = output.split('\n');
  for (const line of lines) {
    if (line.includes(`DEBUG|${key}|`)) {
      return line.split(`DEBUG|${key}|`)[1]?.trim();
    }
  }
  return null;
}

/**
 * Extract all debug log lines from Apex output.
 */
export function extractDebugLines(output) {
  // Decode HTML entities (sf CLI encodes | as &#124; in debug output)
  const decoded = output.replace(/&#124;/g, '|');
  return decoded
    .split('\n')
    .filter(l => l.includes('USER_DEBUG'))
    .map(l => {
      const match = l.match(/USER_DEBUG\s*\|\s*\[\d+\]\s*\|DEBUG\|(.+)/);
      return match ? match[1].trim() : null;
    })
    .filter(Boolean);
}
