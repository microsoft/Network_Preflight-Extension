# Network Preflight (HTTP/DNS/TCP)
Validate **HTTP**, **DNS**, and **TCP** connectivity from your build/release agents **before critical deployments**. Catch network issues early, fail fast, and ship with confidence.

---

## ✅ Why use Network Preflight?
- Detect **firewall or DNS issues** before production releases.
- Validate **critical endpoints** (APIs, databases, identity providers) from the actual agent environment.
- Reduce deployment failures caused by **network misconfigurations**.

---

## 🚀 Features
- **HTTP(S) Check**  
  Validate URLs for reachability, status codes, latency, and optional headers.
- **DNS Lookup**  
  Resolve A/AAAA/CNAME records with optional expected target validation.
- **TCP Probe**  
  Test raw TCP connectivity to `host:port` with configurable retries and timeouts.

---

## 📦 Tasks Overview
| Task Name       | Purpose                                  | Key Inputs                                  |
|-----------------|------------------------------------------|---------------------------------------------|
| `HttpCheckV1`   | Validate HTTP(S) endpoints              | `url`, `method`, `expectedStatus`          |
| `DnsLookupV1`   | Resolve DNS records                     | `hostname`, `expectedRecordType`           |
| `TcpProbeV1`    | Test TCP connectivity                   | `host`, `port`, `timeoutSeconds`           |

All tasks run on **Node 20** (current Azure Pipelines guidance).

---

## ✅ YAML Example
```yaml
pool:
  vmImage: 'ubuntu-latest'

steps:
  - task: HttpCheck@1
    inputs:
      targets: |
        https://contoso.com/health
        https://learn.microsoft.com
      method: HEAD
      timeoutSeconds: 10
      expectStatus: 200-399

  - task: DnsLookup@1
    inputs:
      targets: |
        contoso.com
      recordType: A

  - task: TcpProbe@1
    inputs:
      targets: |
        contoso.com:443
      useTls: true
```
---

## ⚠️ Support Disclaimer
This extension is not an officially supported Microsoft product — for issues or feature requests, please create a GitHub issue in the https://github.com/patelsagar63/Network_Preflight-Extension instead of opening a Microsoft Support request.
It is developed and published independently by Microsoft support engineers to assist customers and internal support teams with troubleshooting network connectivity scenarios in Azure DevOps Pipelines.
This extension is provided as-is, without any warranties or guarantees of support from Microsoft.
Use of this extension in production environments should follow your organization's internal validation and governance processes.