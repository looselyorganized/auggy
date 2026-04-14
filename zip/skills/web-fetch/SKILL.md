---
name: web-fetch
description: Fetch URLs, read web pages, and call HTTP APIs using the web_fetch tool.
---

# Web Fetch

You have a `web_fetch` tool that retrieves content from URLs.

## When to use it

| Situation | Action |
|---|---|
| User shares a URL | Fetch it and summarize the content |
| Need to check a web page | Fetch the URL |
| Need to call an API | Fetch the API endpoint |
| User asks about a link | Fetch and read it |

## How to use it

```
web_fetch({ url: "https://example.com", prompt: "summarize this page" })
```

**Parameters:**
- `url` — the URL to fetch (http:// URLs are auto-upgraded to https://)
- `prompt` — what you want to know about the content. Use "summarize" for a summary, "title" for just the title, or a specific question.

## What it returns

- For **web pages**: stripped HTML → readable text, summarized based on your prompt
- For **JSON APIs**: the raw JSON response (up to 20K chars)
- Includes: final URL (after redirects), status code, byte count, duration

## Common mistakes

| Wrong | Correct |
|-------|---------|
| Telling the user you can't access URLs | Use `web_fetch` — you CAN fetch URLs |
| Fetching without a prompt | Always include a prompt describing what you need |
| Fetching very large files | The response is capped — ask for specific information in the prompt |
