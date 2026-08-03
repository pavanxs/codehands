# Threat Model

The authoritative current scope is in [`CURRENT_PLAN.md`](./CURRENT_PLAN.md). This file records only the stable trust assumptions.

## Deployment assumption

The current CodeHands version is for one trusted owner and that owner's agents. It is not a general multi-user service.

## Current safeguards

- Workspace paths are validated before operations are forwarded.
- Symlink and junction escapes are rejected.
- New paths are checked through their nearest existing parent.
- Blocked-command policy is applied before process launch.
- Request sizes and malformed requests are handled with bounded errors.
- Sensitive values and file contents are kept out of audit records.

## Global access model

- Workspace state is global.
- Process state is global.
- Connected agents may access configured workspaces.
- Connected agents may interact with CodeHands-managed processes.

This is an explicit current-version design decision.

## Later multi-user work

Identity, access restrictions, workspace isolation, process ownership, remote deployment policy, and approval workflows are deferred to a possible version 3. They must be reconsidered before CodeHands is used by untrusted users.
