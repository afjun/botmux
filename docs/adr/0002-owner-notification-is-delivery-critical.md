# Make owner notification delivery-critical for Meego webhooks

Botmux accepts a Meego webhook only after its Owner Notification has been sent to the target conversation. A notification send failure returns a non-2xx response so Console releases its delivery claim and Meego can retry; the outbound Lark message uses a stable UUID derived from the webhook delivery ID to make retries idempotent.

## Considered Options

Logging and continuing would preserve workflow availability but could silently omit the promised owner mention. Retrying without a stable message UUID could duplicate mentions.
