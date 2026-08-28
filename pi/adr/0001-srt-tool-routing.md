# ADR 0001: SRT core-tool routing with a private Docker sidecar

## Status

Accepted.

## Decision

Keep Pi, its UI, provider authentication, and audited host adapters on the host. Route model-directed file and shell operations through per-operation SRT processes. Route Docker only through a private, workspace-owned Docker Sandboxes sidecar broker.

## Consequences

The launcher disables native core tools before Pi starts and fails closed until routing verifies its descriptor, controller, policy generation, and tool inventory. Tool secrets are passed directly in the tool environment; controller tokens and control sockets are removed. The sidecar is lazy and persistent, has no default host ports, and may expose only validated loopback mappings.

## Rejected alternatives

- Reinstating the retired VM backend: it expands the trusted runtime and does not preserve host-native Pi/UI behavior.
- Running all Pi inside SRT: this would move provider/UI and audited host adapters into the restricted plane.
- Exposing host Docker or Docker Sandboxes sockets: this grants host control authority rather than bounded workspace Docker access.
- Credential masking/substitution: this changes tool semantics and obscures authentication failures.
