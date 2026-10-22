# Feishu channel in this desktop IPC derivative

This channel is inherited from Comote 0.7.2. For installation and the supported
workflow, see the [repository README](../../../README.md).

In this project's desktop IPC mode:

- Feishu WebSocket events deliver messages to one explicitly bound desktop
  conversation. No public inbound webhook is needed for normal use.
- The first sender must be authorized in the local management UI, then select
  the same conversation using `/use <threadId>`.
- Completed assistant commentary and the final answer are forwarded as ordinary
  messages/cards. IPC mode does not use the upstream incremental green status
  card or automatically attach changed-file buttons.
- Approvals remain owned by the desktop application. Resolve them on the
  computer; this adapter does not automatically approve or provide remote
  approval control in IPC mode.
- Group chats are not supported by this workflow.

The underlying driver retains upstream image/file handling and `/file` support;
these are not a promise of complete attachment or artifact mirroring. Inbound
attachments use the selected project's `.comote/uploads/` folder. Explicit file
sending is fenced to the selected project and retains the upstream 20 MB limit.

The local `/api/channels/feishu/` endpoints provide status, configuration,
runtime start/stop, QR registration and diagnostic inbound handling. Local API
access requires the generated API token. App secrets, sender identities and
conversation state belong only in the private runtime data directory, never in
this source tree.
