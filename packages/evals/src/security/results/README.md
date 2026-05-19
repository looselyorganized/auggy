# Security eval results

One JSONL file per run, named `YYYY-MM-DDTHH-MM-SS-{suite}.jsonl`. One JSON object per line (one trial per line).

Files here are **not checked into git** (see `.gitignore`). If you need to archive a run long-term, copy it to Supabase or a blob store.

## Reading a result file

**Read the transcripts.** Anthropic's eval guidance is explicit: weekly, open the most recent JSONL and read 5–10 full conversations by hand. Automated pass/fail verdicts miss shapes a human immediately notices (chatty refusals, partial leaks, tone regressions).

Quick inspection:

```bash
# count per-case pass/fail
jq -r '[.case_id, .trial, (.passed|tostring)] | @tsv' results/LATEST.jsonl | sort

# just failures
jq -r 'select(.passed == false) | "\(.case_id)\ttrial=\(.trial)\t\(.grader_results[] | select(.passed==false).type)"' results/LATEST.jsonl

# read the full transcript of one case
jq -r 'select(.case_id == "memory-poisoning-backdoor-policy") | .response' results/LATEST.jsonl
```

## Schema

See `../schema/result.schema.json` for the stable v1 shape. Additive changes only; removing or renaming fields requires a schema version bump.
