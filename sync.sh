if [ -z "$SYNC_KEY" ]; then
  echo "::error::AZURE_FUNCTIONAPP_SYNC_KEY is empty. Set it to the Function App's" \
       "_master key (Portal -> App keys -> _master, or 'az functionapp keys list')." \
       "If the repo uses a 'production' Environment, the secret must be visible to it."
  exit 1
fi
status=$(curl -sS -X POST \
  -o response.txt -w '%{http_code}' \
  -H "x-functions-key: $SYNC_KEY" \
  "https://${APP_NAME}.azurewebsites.net/admin/host/synctriggers")
echo "synctriggers returned HTTP $status"
if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
  echo "::error::Trigger sync failed with HTTP $status."
  cat response.txt
  exit 1
fi
