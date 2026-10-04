# Pi Sandbox Context

This glossary defines Pi's sandbox authority and grant scopes. It separates shared defaults from each client's access and each conversation's execution mode.

## Language

**Saved grant**:
A global configured default for read-only or read-write access to a safe existing directory.
_Avoid_: Session grant, once grant

**Effective grant**:
A configured directory grant in one client's active effective policy.
_Avoid_: Global active grant

**Derived access**:
Workspace or tool access independent of saved grants.
_Avoid_: Editable grant

**Effective policy**:
One client's active snapshot of derived access and effective grants.
_Avoid_: Shared session policy

**Sandbox on**:
The execution mode that confines core file and shell operations to sandbox authority.
_Avoid_: Planning mode

**Sandbox off**:
An explicit conversation-local execution mode with ordinary host-user authority.
_Avoid_: Controller bypass mode, permanent grant

**Planning mutation guard**:
An independent restriction on mutations, separate from sandbox execution mode.
_Avoid_: Sandbox permission

**Private Docker**:
The workspace-specific Docker authority isolated from host containers and host Docker credentials.
_Avoid_: Host Docker exception

**Host Docker**:
The Docker authority selected by ordinary host-user configuration.
_Avoid_: Private sidecar

## Relationships

- One **Saved grant** can supply **Effective grants** in multiple clients.
- Each client has one **Effective policy**, separate from other clients that share a controller.
- An **Effective policy** combines **Derived access** and **Effective grants**.
- Removal of a **Saved grant** does not revoke **Derived access**.
- **Sandbox off** belongs to one conversation in one client, not the shared controller or its child agents.
- The **Planning mutation guard** restricts mutations in both **Sandbox on** and **Sandbox off**.
- **Sandbox on** selects **Private Docker**. **Sandbox off** selects **Host Docker**.

## Example dialogue

> **Dev:** "Does a new **Saved grant** change every client's **Effective policy**?"
> **Domain expert:** "No. Existing clients retain separate snapshots until an explicit refresh. New clients use the saved defaults."
> **Dev:** "Does **Sandbox off** also disable the **Planning mutation guard**?"
> **Domain expert:** "No. Host-user authority and permission to mutate are separate."

## Flagged ambiguities

- "Session grant" conflated saved defaults with active access. Resolved: **Saved grant** and **Effective grant** have distinct scopes.
- "Sandbox off" implied a shared-controller change. Resolved: it selects host execution for one client's current conversation only.
- "Docker access" conflated isolated and host authority. Resolved: **Private Docker** and **Host Docker** remain separate.
