import tl = require('azure-pipelines-task-lib/task');
import fs = require('fs');
import path = require('path');
const dnsPromises = require('dns').promises;

// Publish summary
function publishSummary(name: string, fileBase: string, markdown: string) {
  const dir = process.env['AGENT_TEMPDIRECTORY'] || process.cwd();
  const filePath = path.join(dir, fileBase);
  fs.writeFileSync(filePath, markdown, { encoding: 'utf8' });

  console.log(`##vso[task.uploadsummary]${filePath}`);
}

const mdSafe = (s: string) => String(s).replace(/\|/g, '\\|');

async function run() {
  try {
    const names = tl.getDelimitedInput('targets', '\n', true).filter(Boolean);
    const type = (tl.getInput('recordType', true) || 'A').toUpperCase();
    const resolverAddr = tl.getInput('resolver', false);
    const retries = Number(tl.getInput('retries', false) || '0');
    const timeoutMs = Number(tl.getInput('timeoutSeconds', false) || '10') * 1000;

    // Create resolver (nslookup style)
    const resolver = new dnsPromises.Resolver();
    if (resolverAddr) resolver.setServers([resolverAddr]);

    tl.info('=== Network Preflight: DNS Lookup ===');
    tl.info(`Record Type: ${type} | Timeout: ${timeoutMs / 1000}s | Retries: ${retries}`);

    if (resolverAddr) {
      tl.info(`Using custom DNS resolver: ${resolverAddr}`);
    } else {
      tl.info(`Using system-configured resolver`);
    }

    type Result = {
      name: string;
      type: string;
      answers?: any[];
      passed: boolean;
      error?: string;
      reason?: string;
    };

    const results: Result[] = [];

    for (const raw of names) {
      const name = raw.trim().replace(/\.$/, '');

      console.log(`##[group]DNS Lookup: ${name}`);

      let attempt = 0;
      let passed = false;
      let answers: any[] | undefined;
      let lastErr: any;
      let reason: string | undefined;

      while (attempt <= retries && !passed) {
        tl.info(`Attempt ${attempt + 1} of ${retries + 1}`);

        try {
          // Add manual timeout wrapper
          answers = await Promise.race([
            resolver.resolve(name, type),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), timeoutMs)
            )
          ]) as any[];

          passed = Array.isArray(answers) && answers.length > 0;

          if (passed) {
            tl.info(`Resolved: ${JSON.stringify(answers)}`);
            reason = undefined;

            // Insight for DNS scenarios
            if (type === 'A' || type === 'AAAA') {
              tl.info(`IP resolution successful — verify firewall allows these IPs`);
            }

          } else {
            reason = 'No records returned';
            tl.warning(`No records returned`);
          }

        } catch (e: any) {
          lastErr = e;
          const code = e?.code ? ` (${e.code})` : '';
          reason = `${e?.message || 'resolve error'}${code}`;

          tl.warning(`DNS query failed: ${reason}`);

          // Provide actionable hints
          if (e?.code === 'ENOTFOUND') {
            tl.warning('Possible causes: incorrect hostname, missing DNS record, or private DNS not configured');
          }
          if (e?.code === 'SERVFAIL') {
            tl.warning('Possible causes: DNS server issue or misconfigured resolver');
          }
          if (e?.code === 'ETIMEOUT') {
            tl.warning('Possible causes: DNS blocked by firewall or network rules');
          }
        }

        if (!passed && attempt++ < retries) {
          const backoff = 250 * attempt;
          tl.info(`Retrying in ${backoff} ms...`);
          await new Promise(r => setTimeout(r, backoff));
        }
      }

      if (passed) {
        tl.info(`✅ PASS: ${name}`);
      } else {
        tl.error(`❌ FAIL: ${name} - ${reason ?? lastErr?.message ?? 'Unknown error'}`);
      }

      results.push({
        name,
        type,
        passed,
        answers,
        error: answers ? undefined : (lastErr?.message ?? 'unknown error'),
        reason
      });

      console.log(`##[endgroup]`);
    }

    // Console summary
    tl.info('----------------------------------------');
    tl.info('Network Preflight Summary (DNS):');

    results.forEach(r => {
      const status = r.passed ? 'PASS' : 'FAIL';
      const val = r.answers ? JSON.stringify(r.answers) : r.error ?? '-';
      tl.info(`${status} | ${r.name} | ${r.type} | ${val}`);
    });

    tl.info('----------------------------------------');

    // Markdown summary
    const lines = [
      `# Network Preflight — DNS`,
      ``,
      `**Record Type:** ${type}  `,
      `**Retries:** ${retries}  `,
      resolverAddr ? `**Resolver:** ${resolverAddr}  ` : `**Resolver:** system default  `,
      ``,
      `| Name | Type | Answers | Result | Details |`,
      `|---|:--:|---|:--:|---|`
    ];

    for (const r of results) {
      const val = r.answers ? JSON.stringify(r.answers) : '-';
      lines.push(
        `| ${mdSafe(r.name)} | ${r.type} | ${mdSafe(val)} | ${r.passed ? '✅' : '❌'} | ${mdSafe(r.reason ?? r.error ?? '-')} |`
      );
    }

    publishSummary('Network Preflight — DNS', 'dns-summary.md', lines.join('\n'));

    const failed = results.filter(r => !r.passed).map(r => r.name);

    tl.setVariable('NetworkPreflight.DnsFailedTargets', failed.join(','));

    failed.length
      ? tl.setResult(tl.TaskResult.Failed, `Unresolved DNS: ${failed.join(', ')}`)
      : tl.setResult(tl.TaskResult.Succeeded, 'All DNS lookups resolved');

  } catch (err: any) {
    tl.setResult(tl.TaskResult.Failed, err?.message ?? String(err));
  }
}

run();