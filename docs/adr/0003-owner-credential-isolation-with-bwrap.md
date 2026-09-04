---
status: accepted
---

# Isolate owner credentials with session-frozen bwrap mounts

Bots may opt into owner credential isolation. An isolated Session binds to the
normalized enterprise-email prefix of its Credential Principal: the first
successfully verified Meego owner for webhook sessions, or the initiating human
sender for chat sessions. Credentials live below `owners/<email-prefix>/` and
are reused across Bots; Bots without the policy keep using host login state.

Each Session freezes the Bot's credential mount policy at creation. A mount maps
an owner-private source to one concrete path below `$HOME` inside bwrap and may
declare a structured, shell-free bootstrap command plus success paths, an
optional check command. Configuration changes affect only new Sessions. Failure
to resolve an owner, establish bwrap, verify a mount, or complete bootstrap fails
closed rather than exposing host credentials.

Only the Credential Principal may drive the Agent CLI. Bootstrap is serialized
per owner and mount, while normal Session access is shared. Botmux automatically
starts missing login flows, pauses the first business turn, and publishes login
links, device codes, QR screenshots, and status in the originating conversation.
Anyone who can view the conversation may complete that login; the system
intentionally does not verify that the resulting account is the Session owner.

The Bot configuration supplies built-in presets for bytedcli, ByteCloud CLI,
DevFlow, and the Playwright browser profile, plus structured custom mounts.
Configuration is managed in `bots.json`; Dashboard editing is outside the first
implementation. Playwright has no generic bootstrap: site-specific login happens
when a business turn opens that site and the owner profile persists the result.
Existing host credentials are neither copied into owner storage nor merged back.
Webhook Connectors declare a structured credential-owner extractor rather than
relying on a hard-coded Meego payload path. Candidates are evaluated in payload
order and the first owner whose Open ID resolves through the target Bot's Feishu
contact API and whose email prefix matches the payload becomes the Credential
Principal. Because Feishu Open IDs are app-scoped, an ID that the target Bot
cannot resolve is rejected rather than being treated as a portable identity.

## Considered Options

A complete per-owner HOME was rejected because operators need to add credential
paths dynamically without changing unrelated HOME behavior. App-scoped Open IDs
were rejected as the storage key because credentials must be reusable across
Bots. Allowing arbitrary mount targets was rejected because a mistaken policy
could shadow system, project, or Botmux authority paths.

## Consequences

The first implementation supports Linux bwrap with managed PTY and tmux
Sessions. Unsupported backends, adopt sessions, missing owners, and invalid
policies fail closed. Existing Sessions retain their creation-time policy and
must be closed explicitly when an urgent policy change needs immediate effect.
This first implementation is a functional demo, not a host-security boundary:
it does not defend against the Botmux daemon, the host account or root, a
malicious configuration administrator, email-prefix reassignment, or a different
person completing a publicly visible login flow.
