# Pistacho
Pistacho Cigar Rating System

## Translation Configuration

To enable automatic multilingual translations for rating titles and reviews, configure the following environment variables for the serverless functions:

| Variable | Description |
| --- | --- |
| `BAIDU_TRANSLATE_APP_ID` | Baidu Translate APP ID |
| `BAIDU_TRANSLATE_APP_SECRET` | Baidu Translate secret key |

If the credentials are not provided, ratings will still be saved, but the original text will be used for every language.
   