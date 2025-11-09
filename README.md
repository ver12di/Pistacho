# Pistacho
Pistacho Cigar Rating System

## Translation setup

The backend integrates the Baidu translation API to localize user-generated reviews and comments. Configure the following environment variables for the Cloudflare Worker runtime:

- `BAIDU_TRANSLATE_APP_ID`
- `BAIDU_TRANSLATE_SECRET_KEY`
- `TRANSLATION_TARGET_LANGS` (optional, comma-separated two-letter codes; defaults to `en,es,fr,de,ja,ko,ru,pt`)
- `TRANSLATION_SOURCE_LANG` (optional, defaults to `zh`)

Never commit API credentials to the repository. Provide them through environment variables in your deployment configuration.
   