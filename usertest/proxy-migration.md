# User-test host and IAP

`server.sh` defaults to `https://integrations.atomic.place`, preserving an
explicit `ATOMIC_INTEGRATION_PROXY_URL` for a custom or loopback receiver.
The browser host must support client-held connection keys: changing only
the URL of a historical image does not migrate its authentication.

The current `.atomic-server-ref`,
`30994948b5adadd765ecfcdccdf0aad14ef5be1a`, predates the browser changes in
atomic-server#2490 (`a450e20fc0d949958ec8187724dfa6c9423a8f66`). It lacks
`x-connection-key` and connection-key derivation. `server.sh` refuses that
known incompatible image with IAP before pulling or stopping a container.
The pin is unchanged. A compatible replacement must be selected and tested
before deploying the user-test host with IAP; neither this default change
nor the offline tests establish live host compatibility.

The host must derive the owner's key locally, seal app-frame grants, and
bind the connection-key header into the request signature. No key belongs
in this script or its environment settings. Retain existing custom proxy
settings when running historical images against isolated test receivers.

Offline deployment-argument and preflight checks use a fake Docker command:

```sh
node --test usertest/server.test.mjs
```
