# Disable built-in MCP

## Context

Pi reports a command collision because the routing extension intentionally supplies `/mcp` using Pi’s exported MCP factory. The user requested disabling the built-in MCP extension. The supported setting is `extensions: ["-builtin:mcp"]` in `pi/agent/settings.json`.

The routed `/mcp` remains available during normal launches. This setting also disables automatic built-in MCP loading in bare upstream Pi and `--yolo`; an explicit `-e builtin:mcp` can enable it for a host-native session. Shell-level `pi mcp` commands remain unaffected. This narrow change does not modify launcher behavior, sandbox policy, or Visonic configuration.

## Approach

Use Pi’s supported resource exclusion setting rather than suppressing diagnostics or patching installed Pi.

### Part A — Disable and deploy the built-in extension
- **Ledger:** {"status":"completed","note":null,"evidence":"Added only extensions: [\"-builtin:mcp\"] relative to the pre-existing settings changes. ./install.sh config exited 0. Validated JSON and ~/.pi/agent/settings.json realpath equals managed file. npm --prefix pi run check exited 0 (log /tmp/pi-disable-builtin-mcp-check.log); its settings side effects were restored to the initial model values. git diff --check passed. Fresh normal-launch offline RPC startup returned /mcp in get_commands and produced no collision/conflict/warning/error diagnostics (log /tmp/pi-disable-builtin-mcp-startup.log); startup preserved settings. Existing interactive session requires user restart."}

Add `-builtin:mcp` to the managed extensions array, preserving all other settings and existing dirty changes. Deploy only through `./install.sh config`. Verify valid JSON and the deployed setting. Confirm that the routing extension still registers `/mcp`; do not remove or rename it. Report deployment failures rather than claiming success. Restart Pi to apply the extension selection.

## Verification

Check the settings diff contains only the extension exclusion. Verify the deployed settings resolve to the managed file and contain the exclusion. Run the deployment command and inspect its exit status. Check `git diff --check`. Where feasible, inspect actual startup diagnostics to confirm the built-in MCP collision warning is absent.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Disable and deploy the built-in extension
<!-- pi-plan-mode:progress:end -->
