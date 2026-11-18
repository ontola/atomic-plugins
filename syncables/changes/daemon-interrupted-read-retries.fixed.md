SyncD retries interrupted metadata reads after recognized network resets
and request timeouts, within the same limits as gateway retries. The
archive records each interruption before a retry. A proxy page has
enough time to receive the proxy's upstream timeout response.
