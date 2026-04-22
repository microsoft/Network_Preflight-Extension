import tl = require('azure-pipelines-task-lib/task');
import { setTimeout as delay } from 'timers/promises';
import fs = require('fs');
import path = require('path');
import dns from 'dns/promises';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Publish Markdown summary
function publishSummary(name: string, fileBase: string, markdown: string) {
  const dir = process.env['AGENT_TEMPDIRECTORY'] || process.cwd();
  const filePath = path.join(dir, fileBase);
  fs.writeFileSync(filePath, markdown, { encoding: 'utf8' });

  console.log(`##vso[task.uploadsummary]${filePath}`);
}

// Parse status expression
function parseStatusExpr(expr: string) {
  const parts = expr.split(',').map(s => s.trim()).filter(Boolean);
  return (code: number) =>
    parts.some(p => {
      const [aRaw, bRaw] = p.split('-');
      const a = Number(aRaw);
      const b = bRaw !== undefined ? Number(bRaw) : NaN;
      if (!Number.isFinite(a)) return false;
      return Number.isFinite(b) ? (code >= a && code <= b) : (code === a);
    });
}

async function resolveIP(url: string) {
  try {
    const hostname = new URL(url).hostname;
    const res = await dns.lookup(hostname);
    return res.address;
  } catch {
    return undefined;
  }
}

async function checkOnce(url: string, method: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const started = Date.now();
  const res = await fetch(url, { method, signal: controller.signal });
  const latency = Date.now() - started;

  clearTimeout(timer);

  const server = res.headers.get('server') ?? undefined;
  const via = res.headers.get('via') ?? undefined;

  return { status: res.status, ok: res.ok, latency, server, via };
}

const mdSafe = (s: string) => s.replace(/\|/g, '\\|');

async function run() {
  try {
    const targets = tl.getDelimitedInput('targets', '\n', true).filter(Boolean);
    const method = tl.getInput('method', true)!;

    const timeoutMs = Number(tl.getInput('timeoutSeconds', false) || '10') * 1000;
    const retries = Number(tl.getInput('retries', false) || '0');

    const expectStatusExpr = tl.getInput('expectStatus', false) || '200-399';
    const maxLatencyMs = Number(tl.getInput('maxLatencyMs', false) || '0');

    const expectStatus = parseStatusExpr(expectStatusExpr);

    // Capture proxy-related environment info
    const proxyInfo = {
      HTTP_PROXY: process.env['HTTP_PROXY'] || process.env['http_proxy'],
      HTTPS_PROXY: process.env['HTTPS_PROXY'] || process.env['https_proxy'],
      NO_PROXY: process.env['NO_PROXY'] || process.env['no_proxy']
    };

    console.log('=== Network Preflight: HTTP(S) Check ===');

    if (proxyInfo.HTTP_PROXY || proxyInfo.HTTPS_PROXY) {
      console.log(`Detected proxy configuration:`);
      if (proxyInfo.HTTP_PROXY) console.log(`  HTTP_PROXY: ${proxyInfo.HTTP_PROXY}`);
      if (proxyInfo.HTTPS_PROXY) console.log(`  HTTPS_PROXY: ${proxyInfo.HTTPS_PROXY}`);
      if (proxyInfo.NO_PROXY) console.log(`  NO_PROXY: ${proxyInfo.NO_PROXY}`);
    } else {
      console.log(`No proxy environment variables detected`);
    }

    type Result = {
      url: string;
      passed: boolean;
      status?: number;
      latency?: number;
      error?: string;
      reason?: string;
      server?: string;
      via?: string;
      ip?: string;
    };

    const results: Result[] = [];

    for (const url of targets) {
      console.log(`##[group]Checking ${url}`);

      let attempt = 0;
      let lastErr: any;
      let r: any = {};
      let passed = false;
      let reason: string | undefined;

      const ip = await resolveIP(url);
      if (ip) {
        console.log(`Resolved IP: ${ip}`);
      } else {
        tl.warning(`Could not resolve IP address`);
      }

      while (attempt <= retries && !passed) {
        console.log(`Attempt ${attempt + 1} of ${retries + 1}`);

        try {
          r = await checkOnce(url, method, timeoutMs);

          const statusOk = expectStatus(r.status);
          const latencyOk = (!maxLatencyMs || r.latency <= maxLatencyMs);

          console.log(`Response: status=${r.status}, latency=${r.latency}ms`);

          if (r.server || r.via) {
            console.log(`Headers: server=${r.server ?? '-'}, via=${r.via ?? '-'}`);
          }

          passed = statusOk && latencyOk;

          if (!statusOk) {
            reason = `Unexpected status (${r.status})`;
            tl.warning(`Expected ${expectStatusExpr}, got ${r.status}`);
          } else if (!latencyOk) {
            reason = `Latency too high (${r.latency}ms > ${maxLatencyMs}ms)`;
            tl.warning(`Latency threshold exceeded`);
          } else {
            reason = undefined;
          }

        } catch (e: any) {
          lastErr = e;
          reason = e?.name === 'AbortError'
            ? `Timeout after ${timeoutMs}ms`
            : (e?.message ?? 'Request failed');

          tl.warning(`Error: ${reason}`);
        }

        if (!passed && attempt++ < retries) {
          const backoff = 250 * attempt;
          console.log(`Retrying in ${backoff} ms...`);
          await delay(backoff);
        }
      }

      if (passed) {
        console.log(`✅ PASS: ${url}`);
      } else {
        tl.error(`❌ FAIL: ${url} - ${reason ?? lastErr?.message ?? 'Unknown error'}`);
      }

      results.push({
        url,
        passed,
        ...r,
        reason,
        error: r?.status ? undefined : (lastErr?.message ?? 'unknown error'),
        ip
      });

      console.log(`##[endgroup]`);
    }

    // Console summary (very useful for users)
    console.log('----------------------------------------');
    console.log('Network Preflight Summary:');

    results.forEach(r => {
      const status = r.status ?? r.error ?? 'error';
      const latency = r.latency ?? '-';
      const result = r.passed ? 'PASS' : 'FAIL';
      console.log(`${result} | ${r.url} | ${status} | ${latency}ms | IP=${r.ip ?? '-'}`);
    });

    console.log('----------------------------------------');

    // Markdown summary
    const lines: string[] = [
      `# Network Preflight — HTTP(S)`,
      ``,
      `**Method:** ${method}  `,
      `**Timeout:** ${Math.round(timeoutMs / 1000)}s  `,
      `**Retries:** ${retries}  `,
      `**Expected:** ${expectStatusExpr}  `,
      maxLatencyMs ? `**Max latency:** ${maxLatencyMs}ms  ` : `**Max latency:** (not enforced)  `,
      ``,
      `| URL | IP | Status | Latency (ms) | Result | Details |`,
      `|---|---|---|---:|:--:|---|`
    ];

    for (const r of results) {
      lines.push(
        `| ${mdSafe(r.url)} | ${r.ip ?? '-'} | ${r.status ?? r.error} | ${r.latency ?? '-'} | ${r.passed ? '✅' : '❌'} | ${mdSafe(r.reason ?? r.error ?? '-')} |`
      );
    }

    publishSummary('Network Preflight — HTTP(S)', 'http-summary.md', lines.join('\n'));

    const failed = results.filter(r => !r.passed).map(r => r.url);
    tl.setVariable('NetworkPreflight.FailedTargets', failed.join(','));

    failed.length
      ? tl.setResult(tl.TaskResult.Failed, `HTTP check failed for: ${failed.join(', ')}`)
      : tl.setResult(tl.TaskResult.Succeeded, 'All HTTP checks passed');

  } catch (err: any) {
    tl.setResult(tl.TaskResult.Failed, err?.message ?? String(err));
  }
}

run();