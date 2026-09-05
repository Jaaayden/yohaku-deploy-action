# Build API proxy

The workflow builds unmodified `innei-dev/Yohaku` source. Deployment tooling is
copied to `RUNNER_TEMP` before the source checkout, outside standalone tracing.
The wrapper supplies a loopback `API_URL` only to the build child process;
`NEXT_PUBLIC_API_URL` remains unchanged. Nothing is added to the production API.

The proxy accepts unauthenticated GETs beneath the configured API prefix only.
It keeps successful JSON `/aggregate` responses for ten minutes, keyed by full
URL (including language and theme), and coalesces identical in-flight requests.
Other GETs are never cached. Cookies and authorization are rejected; headers are
not forwarded. Redirects are rejected to avoid following arbitrary destinations.

All workers share one upstream queue with at least 250 ms between request starts.
429 and transient gateway failures get up to three retries, respecting
`Retry-After` or using 1/2/4 second backoff. A server-requested delay over 60 seconds
fails instead of retrying early. Each upstream attempt times out in seven seconds.
Only counters are logged; URLs, credentials and response bodies are not printed.
Next.js's own request timeout still applies: a prolonged outage or a sufficiently
large queue can legitimately fail the build. This does not suppress API errors.

`node --test scripts/build-api-proxy.test.mjs` covers deduplication, language
separation, pacing, retry bounds, expiry, access restrictions and child environment
isolation. After assembling standalone, a smoke test starts it with a different
runtime API endpoint, checks five language pages and a missing dynamic post. This
catches accidentally baking the build endpoint into production code.

Use workflow_dispatch with `deploy=false` to validate without changing production.
Normal deployments retain their previous behavior. The existing Store job depends
on Deploy, so validation-only builds do not update `build_hash`.

Rollback: revert the workflow/tooling commit. No upstream source, production
configuration or content needs to be restored.
