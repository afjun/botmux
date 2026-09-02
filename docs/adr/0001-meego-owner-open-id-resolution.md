# Resolve Meego owner Open IDs with the target Botmux application's credentials

Console resolves Meego owner emails through the Feishu contact API using the target Botmux application's TCC-managed credentials, then sends the resulting Open IDs to Botmux. This keeps each Open ID in the same application scope as the bot that performs the native mention; credentials remain encrypted configuration and are never included in webhook payloads or logs.

## Considered Options

Resolving with Console's own Feishu application was rejected because the resulting Open ID may not be valid for the Botmux application's native mention. Deferring all resolution to Botmux was rejected because Console owns the Meego-to-identity enrichment boundary and must pass the complete owner context downstream.
