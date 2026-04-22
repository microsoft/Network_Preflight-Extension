import tl = require('azure-pipelines-task-lib/task');
import fs = require('fs');
import path = require('path');
import net = require('net');
import tls = require('tls');
import dns from 'dns/promises';
import crypto from 'crypto';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function publishSummary(name: string, fileBase: string, markdown: string) {
  const dir = process.env['AGENT_TEMPDIRECTORY'] || process.cwd();
  const filePath = path.join(dir, fileBase);
  fs.writeFileSync(filePath, markdown, { encoding: 'utf8' });

  // Shorthand for attaching a Markdown summary to the run. [1](https://learn.microsoft.com/en-us/azure/devops/pipelines/scripts/logging-commands?view=azure-devops)
  console.log(`##vso[task.uploadsummary]${filePath}`);
}

function mdSafe(s: string) {
  return String(s).replace(/\|/g, '\\|');
}

/**
 * Accepts:
 *   - host:port
 *   - https://host:port (or http://host:port)
 *   - [ipv6]:port
 *   - bare host (port defaults based on TLS)
 */
function normalizeTarget(entry: string, defaultUseTls: boolean) {
  let raw = entry.trim();
  let useTls = defaultUseTls;
  let host: string;
  let port: number | undefined;
  let serverName: string | undefined;

  // URL form?
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    const u = new URL(raw);
    host = u.hostname;
    if (u.port) port = parseInt(u.port, 10);
    if (u.protocol === 'https:') { useTls = true;  port ??= 443; }
    if (u.protocol === 'http:')  { useTls = false; port ??= 80;  }
  } else {
    // IPv6 [addr]:port
    const m6 = raw.match(/^\[([^\]]+)\]:(\d+)$/);
    if (m6) {
      host = m6[1];
      port = parseInt(m6[2], 10);
    } else {
      // host:port (no scheme), or bare host
      const parts = raw.split(':');
      if (parts.length === 2 && !parts[0].includes('/')) {
        host = parts[0];
        port = parseInt(parts[1], 10);
      } else {
        host = raw;
      }
    }
    port ??= useTls ? 443 : 80;
  }

  // Set SNI automatically for DNS names (not IP literals)
  const isIpLiteral = net.isIP(host) !== 0;
  if (useTls && !isIpLiteral) {
    serverName = host;
  }

  return { host, port: port!, useTls, serverName };
}

async function resolveIPs(host: string): Promise<string[]> {
  try {
    if (net.isIP(host) !== 0) return [host]; // already an IP literal
    const records = await dns.lookup(host, { all: true });
    const ips = Array.from(new Set(records.map(r => r.address)));
    return ips;
  } catch {
    return [];
  }
}

function formatCertCN(subject: any): string | undefined {
  const cn = subject?.CN || subject?.commonName;
  return cn ? String(cn) : undefined;
}

function sha256Fingerprint(der?: Buffer): string | undefined {
  if (!der || !Buffer.isBuffer(der)) return undefined;
  const hash = crypto.createHash('sha256').update(der).digest('hex');
  // Pretty-print as AA:BB:CC...
  return hash.match(/.{1,2}/g)?.join(':');
}

type ProbeResult = {
  latency: number;
  remoteAddress?: string;
  remotePort?: number;
  localAddress?: string;
  localPort?: number;

  // TLS-only
  tls?: {
    authorized?: boolean;
    authorizationError?: string;
    protocol?: string | null;
    cipher?: string;
    alpn?: string;
    sni?: string;
    certSubjectCN?: string;
    certIssuerCN?: string;
    certSAN?: string;
    certValidTo?: string;
    certFingerprintSha256?: string;
  };
};

function probe(host: string, port: number, timeoutMs: number, useTls: boolean, serverName?: string) {
  return new Promise<ProbeResult>((resolve, reject) => {
    const started = Date.now();

    const onErr = (err: any) => {
      const code = err?.code ? ` (${err.code})` : '';
      const reason = err?.reason ? `: ${err.reason}` : '';
      reject(new Error(`${err?.message || 'connect error'}${code}${reason}`));
    };

    const finishOk = (sock: net.Socket | tls.TLSSocket) => {
      const latency = Date.now() - started;

      const base: ProbeResult = {
        latency,
        remoteAddress: (sock as any).remoteAddress,
        remotePort: (sock as any).remotePort,
        localAddress: (sock as any).localAddress,
        localPort: (sock as any).localPort
      };

      if (useTls) {
        const t = sock as tls.TLSSocket;
        const cert = t.getPeerCertificate(true) as any;
        const subjectCN = formatCertCN(cert?.subject);
        const issuerCN = formatCertCN(cert?.issuer);
        const san = cert?.subjectaltname ? String(cert.subjectaltname) : undefined;
        const validTo = cert?.valid_to ? String(cert.valid_to) : undefined;
        const fp = sha256Fingerprint(cert?.raw);

        base.tls = {
          authorized: t.authorized,
          authorizationError: t.authorizationError ? String(t.authorizationError) : undefined,
          protocol: t.getProtocol?.() ?? undefined,
          cipher: t.getCipher?.()?.name ?? undefined,
          alpn: t.alpnProtocol || undefined,
          sni: serverName,
          certSubjectCN: subjectCN,
          certIssuerCN: issuerCN,
          certSAN: san,
          certValidTo: validTo,
          certFingerprintSha256: fp
        };
      }

      sock.destroy();
      resolve(base);
    };

    const options: tls.ConnectionOptions & net.NetConnectOpts = { host, port };
    let sock: net.Socket | tls.TLSSocket;

    if (useTls) {
      (options as tls.ConnectionOptions).rejectUnauthorized = true;
      if (serverName) (options as tls.ConnectionOptions).servername = serverName;

      sock = tls.connect(options, () => finishOk(sock));
    } else {
      sock = net.connect(options, () => finishOk(sock));
    }

    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      onErr(new Error('timeout'));
    });

    sock.on('error', onErr);
  });
}

async function run() {
  try {
    const targets = tl.getDelimitedInput('targets', '\n', true).filter(Boolean);
    const timeoutMs = Number(tl.getInput('timeoutSeconds', false) || '10') * 1000;
    const defaultUseTls = tl.getBoolInput('useTls', false);
    const serverNameOverride = tl.getInput('serverName', false);

    // Optional (safe even if not in task.json): retries
    const retries = Number(tl.getInput('retries', false) || '0');

    const proxyInfo = {
      HTTP_PROXY: process.env['HTTP_PROXY'] || process.env['http_proxy'],
      HTTPS_PROXY: process.env['HTTPS_PROXY'] || process.env['https_proxy'],
      NO_PROXY: process.env['NO_PROXY'] || process.env['no_proxy'],
      ALL_PROXY: process.env['ALL_PROXY'] || process.env['all_proxy']
    };

    console.log('=== Network Preflight: TCP Probe ===');
    console.log(`Timeout: ${Math.round(timeoutMs / 1000)}s | Retries: ${retries} | Default TLS: ${defaultUseTls ? 'true' : 'false'}`);

    // Proxy hints (informational)
    if (proxyInfo.HTTP_PROXY || proxyInfo.HTTPS_PROXY || proxyInfo.ALL_PROXY) {
      console.log('Proxy environment variables detected (informational):');
      if (proxyInfo.HTTP_PROXY) console.log(`  HTTP_PROXY: ${proxyInfo.HTTP_PROXY}`);
      if (proxyInfo.HTTPS_PROXY) console.log(`  HTTPS_PROXY: ${proxyInfo.HTTPS_PROXY}`);
      if (proxyInfo.ALL_PROXY) console.log(`  ALL_PROXY: ${proxyInfo.ALL_PROXY}`);
      if (proxyInfo.NO_PROXY) console.log(`  NO_PROXY: ${proxyInfo.NO_PROXY}`);
    } else {
      console.log('No proxy environment variables detected');
    }

    type Result = {
      target: string;
      normalized: string;
      passed: boolean;
      latency?: number;
      error?: string;

      resolvedIPs?: string[];
      remote?: string;
      local?: string;

      useTls?: boolean;
      sni?: string;
      alpn?: string;
      tlsProtocol?: string | null;
      tlsCipher?: string;

      certSubjectCN?: string;
      certIssuerCN?: string;
      certSAN?: string;
      certValidTo?: string;
      certFingerprintSha256?: string;

      tlsAuthorized?: boolean;
      tlsAuthorizationError?: string;
      reason?: string;
    };

    const results: Result[] = [];

    for (const entry of targets) {
      console.log(`##[group]TCP Probe: ${entry}`);

      let t = normalizeTarget(entry, defaultUseTls);
      if (serverNameOverride) t.serverName = serverNameOverride;

      const normalized = `${t.host}:${t.port}`;
      console.log(`Normalized target: ${normalized}`);
      console.log(`Mode: ${t.useTls ? 'TLS' : 'TCP'}${t.useTls ? ` | SNI=${t.serverName ?? '(none)'}` : ''}`);

      const resolvedIPs = await resolveIPs(t.host);
      if (resolvedIPs.length) {
        console.log(`DNS resolved IPs: ${resolvedIPs.join(', ')}`);
      } else {
        tl.warning(`DNS resolution unavailable (host may be IP literal, or DNS blocked/unreachable)`);
      }

      let attempt = 0;
      let passed = false;
      let lastErr: any;
      let lastProbe: ProbeResult | undefined;
      let reason: string | undefined;

      while (attempt <= retries && !passed) {
        console.log(`Attempt ${attempt + 1} of ${retries + 1}`);

        try {
          lastProbe = await probe(t.host, t.port, timeoutMs, t.useTls, t.serverName);

          const remote = lastProbe.remoteAddress ? `${lastProbe.remoteAddress}:${lastProbe.remotePort ?? ''}` : undefined;
          const local = lastProbe.localAddress ? `${lastProbe.localAddress}:${lastProbe.localPort ?? ''}` : undefined;

          console.log(`Connected: remote=${remote ?? '-'} | local=${local ?? '-'} | latency=${lastProbe.latency}ms`);

          if (resolvedIPs.length && lastProbe.remoteAddress && !resolvedIPs.includes(lastProbe.remoteAddress)) {
            tl.warning(`Remote IP differs from DNS list (possible proxy/LB/NAT path): connected=${lastProbe.remoteAddress}, dns=[${resolvedIPs.join(', ')}]`);
          }

          if (t.useTls && lastProbe.tls) {
            const tlsInfo = lastProbe.tls;
            console.log(`TLS: protocol=${tlsInfo.protocol ?? '-'}, cipher=${tlsInfo.cipher ?? '-'}, ALPN=${tlsInfo.alpn ?? '-'}`);
            console.log(`TLS: authorized=${tlsInfo.authorized ? 'true' : 'false'}${tlsInfo.authorizationError ? ` (${tlsInfo.authorizationError})` : ''}`);

            if (tlsInfo.certSubjectCN || tlsInfo.certIssuerCN) {
              console.log(`Cert: SubjectCN=${tlsInfo.certSubjectCN ?? '-'} | IssuerCN=${tlsInfo.certIssuerCN ?? '-'}`);
            }
            if (tlsInfo.certValidTo) console.log(`Cert: ValidTo=${tlsInfo.certValidTo}`);
            if (tlsInfo.certFingerprintSha256) console.log(`Cert: SHA256=${tlsInfo.certFingerprintSha256}`);
          }

          // “Pass” means we established the connection + (if TLS) completed handshake.
          // If you want to fail when cert is untrusted, keep rejectUnauthorized=true (already).
          passed = true;
          reason = undefined;

        } catch (e: any) {
          lastErr = e;
          reason = e?.message ?? 'connect error';
          tl.warning(`Probe failed: ${reason}`);
        }

        if (!passed && attempt++ < retries) {
          const backoff = 250 * attempt;
          console.log(`Retrying in ${backoff} ms...`);
          await delay(backoff);
        }
      }

      if (passed && lastProbe) {
        const remote = lastProbe.remoteAddress ? `${lastProbe.remoteAddress}:${lastProbe.remotePort ?? ''}` : undefined;
        const local = lastProbe.localAddress ? `${lastProbe.localAddress}:${lastProbe.localPort ?? ''}` : undefined;

        results.push({
          target: entry,
          normalized,
          passed: true,
          latency: lastProbe.latency,
          resolvedIPs,
          remote,
          local,
          useTls: t.useTls,
          sni: t.useTls ? (t.serverName ?? undefined) : undefined,
          alpn: lastProbe.tls?.alpn,
          tlsProtocol: lastProbe.tls?.protocol,
          tlsCipher: lastProbe.tls?.cipher,
          tlsAuthorized: lastProbe.tls?.authorized,
          tlsAuthorizationError: lastProbe.tls?.authorizationError,
          certSubjectCN: lastProbe.tls?.certSubjectCN,
          certIssuerCN: lastProbe.tls?.certIssuerCN,
          certSAN: lastProbe.tls?.certSAN,
          certValidTo: lastProbe.tls?.certValidTo,
          certFingerprintSha256: lastProbe.tls?.certFingerprintSha256
        });

        console.log(`✅ PASS: ${normalized}`);
      } else {
        results.push({
          target: entry,
          normalized,
          passed: false,
          resolvedIPs,
          useTls: t.useTls,
          sni: t.useTls ? (t.serverName ?? undefined) : undefined,
          error: reason ?? lastErr?.message ?? 'unknown error',
          reason: reason ?? lastErr?.message ?? 'unknown error'
        });

        tl.error(`❌ FAIL: ${normalized} - ${reason ?? lastErr?.message ?? 'unknown error'}`);
      }

      console.log(`##[endgroup]`);
    }

    // Console summary (great for non-debug runs)
    console.log('----------------------------------------');
    console.log('Network Preflight Summary (TCP):');
    results.forEach(r => {
      const status = r.passed ? 'PASS' : 'FAIL';
      console.log(`${status} | ${r.normalized} | latency=${r.latency ?? '-'}ms | remote=${r.remote ?? '-'} | tls=${r.useTls ? 'true' : 'false'}`);
    });
    console.log('----------------------------------------');

    // Markdown summary
    const lines: string[] = [
      `# Network Preflight — TCP`,
      ``,
      `**Timeout:** ${Math.round(timeoutMs / 1000)}s  `,
      `**Retries:** ${retries}  `,
      `**Default TLS:** ${defaultUseTls ? 'true' : 'false'}  `,
      ``,
      `| Target | Mode | DNS IPs | Remote | Latency (ms) | ALPN | TLS | Cert Subject CN | Cert Issuer CN | ValidTo | OK |`,
      `|---|---|---|---|---:|:--:|---|---|---|---|:--:|`
    ];

    for (const r of results) {
      const mode = r.useTls ? `TLS${r.sni ? ` (SNI=${r.sni})` : ''}` : 'TCP';
      const dnsIps = r.resolvedIPs?.length ? r.resolvedIPs.join(', ') : '-';
      const tlsMeta = r.useTls
        ? `proto=${r.tlsProtocol ?? '-'}, cipher=${r.tlsCipher ?? '-'}${r.tlsAuthorized === false ? `, untrusted=${r.tlsAuthorizationError ?? 'true'}` : ''}`
        : '-';

      lines.push(
        `| ${mdSafe(r.normalized)} | ${mdSafe(mode)} | ${mdSafe(dnsIps)} | ${mdSafe(r.remote ?? '-')} | ${r.latency ?? '-'} | ${r.alpn ?? '-'} | ${mdSafe(tlsMeta)} | ${mdSafe(r.certSubjectCN ?? '-')} | ${mdSafe(r.certIssuerCN ?? '-')} | ${mdSafe(r.certValidTo ?? '-')} | ${r.passed ? '✅' : '❌'} |`
      );

      if (!r.passed && (r.reason || r.error)) {
        lines.push(`\n> **${mdSafe(r.normalized)} failure:** ${mdSafe(r.reason ?? r.error ?? 'unknown error')}\n`);
      }
    }

    publishSummary('Network Preflight — TCP', 'tcp-summary.md', lines.join('\n'));

    const failed = results.filter(r => !r.passed).map(r => r.normalized);
    failed.length
      ? tl.setResult(tl.TaskResult.Failed, `TCP unreachable: ${failed.join(', ')}`)
      : tl.setResult(tl.TaskResult.Succeeded, 'All TCP targets reachable');

  } catch (err: any) {
    tl.setResult(tl.TaskResult.Failed, err?.message ?? String(err));
  }
}

run();