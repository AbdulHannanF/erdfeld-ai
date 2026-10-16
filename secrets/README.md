# secrets/

Drop your **Google Earth Engine service-account key** here, e.g.:

```
secrets/ee-key.json
```

Then point `.env` at it:

```bash
GEE_KEY_FILE=./secrets/ee-key.json
```

**Never commit the key.** `.gitignore` ignores everything in this folder except this
README. The private key inside the JSON is a credential — treat it like a password.

Full setup walkthrough: `ccdoc/GEE_SETUP.md`.
