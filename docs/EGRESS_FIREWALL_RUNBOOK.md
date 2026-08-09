# Egress Firewall Hardening Runbook

This implementation enforces `PROXY_REQUIRED` in application code. Do not apply
host firewall rules until production dependencies and gateway addresses are
inventoried.

Before hardening, collect:

- configured proxy gateway hostnames and resolved IP ranges
- Postgres endpoint
- Redis endpoint
- MinIO or object-storage endpoint
- DNS resolvers used by the host/container runtime
- deployment, package-registry, monitoring, and certificate-renewal endpoints

Recommended target policy:

- allow social API egress only through the configured proxy gateway
- allow infrastructure egress to Postgres, Redis, object storage, DNS, and
  deployment/monitoring dependencies
- block direct outbound social-provider traffic from API and worker containers
- validate with the proxy regression tests before and after applying rules

Do not automatically modify `iptables`, `nftables`, UFW, Docker network policy,
or cloud firewall rules from the application deployment.
