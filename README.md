## Network Preflight
An **Azure DevOps Pipelines extension** that validates network connectivity **from the build/release agent** before critical deployments. This helps you catch DNS, HTTP, or TCP connectivity issues early in your pipeline.

https://marketplace.visualstudio.com/items?itemName=AzureDevOpsCSS-Sagar.AzureDevOpsCSS-Sagar

## ✅ Why use Network Preflight?
- Detect **firewall or DNS issues** before production releases.
- Validate **critical endpoints** (APIs, databases, identity providers) from the actual agent environment.
- Reduce deployment failures caused by **network misconfigurations**.

## 🚀 Key Capabilities
### ✅ User-friendly pipeline logs (no debug required)
- Clear ✅ PASS / ❌ FAIL status per target
- Structured logs with grouped output
- Actionable failure reasons (timeout, DNS errors, TLS issues)

### ✅ Network path visibility
- DNS resolved IPs vs actual connection IPs
- Detect **load balancers / proxies / NAT paths**

### ✅ TLS inspection (TCP task)
- Protocol, cipher, ALPN
- Certificate subject / issuer / expiry
- Detect untrusted or misconfigured endpoints

### ✅ Retry + timeout controls
- Configure retries for flaky environments
- Control timeout across all tasks

### ✅ Markdown pipeline summary
- Clean tab in pipeline UI
- Tabular results for quick analysis

## 📦 Tasks Overview
| Task Name       | Purpose                                   | Key Inputs |
|----------------|-------------------------------------------|-----------|
| `HttpCheck@1`  | Validate HTTP(S) endpoints                | `targets`, `method`, `expectStatus`, `timeoutSeconds`, `retries` |
| `DnsLookup@1`  | Resolve DNS records                       | `targets`, `recordType`, `resolver`, `timeoutSeconds`, `retries` |
| `TcpProbe@1`   | Test TCP connectivity (TLS optional)      | `targets`, `useTls`, `serverName`, `timeoutSeconds`, `retries` |  

All tasks run on Node 20 (current Azure Pipelines guidance).

## 🛠 Common Inputs
- **targets**  
  Multi-line list of:
  - URLs (HTTP/HTTPS)
  - hostnames (DNS)
  - host:port (TCP)

- **timeoutSeconds**  
  Maximum time per check (default: 10)

- **retries**  
  Retry attempts for transient failures (default: 0)


## 🔧 YAML Example
```yaml
pool:
  vmImage: 'ubuntu-latest'

steps:

# HTTP Check
- task: HttpCheck@1
  inputs:
    targets: |
      https://contoso.com/health
      https://learn.microsoft.com
    method: HEAD
    expectStatus: 200-399
    timeoutSeconds: 10
    retries: 2

# DNS Lookup
- task: DnsLookup@1
  inputs:
    targets: |
      contoso.com
    recordType: A
    resolver: 8.8.8.8
    retries: 2

# TCP Probe + TLS validation
- task: TcpProbe@1
  inputs:
    targets: |
      contoso.com:443
    useTls: true
    retries: 2
```

## ⚠️ Support Disclaimer
This extension is not an officially supported Microsoft product.
For issues or feature requests, please create a GitHub issue in the https://github.com/microsoft/Network_Preflight-Extension instead of opening a Microsoft Support request.
This extension is developed by Microsoft support engineers to help customers and internal teams troubleshoot network connectivity in Azure DevOps pipelines.
This extension is provided as-is, without any warranties or guarantees of support from Microsoft.
Use of this extension in production environments should follow your organization's internal validation and governance processes.