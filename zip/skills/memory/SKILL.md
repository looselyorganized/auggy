---
name: memory
description: When and how to use memory_read, memory_write, memory_search, memory_list tools.
---

# Memory Tools

## When to use each tool

| Situation | Tool | Example |
|---|---|---|
| Need specific labeled content | memory_read | `memory_read("self")` for identity |
| Need to find something by content | memory_search | `memory_search("coffee")` |
| Need to persist something | memory_write | `memory_write("learned", "...")` |
| Need to see what's available | memory_list | Check labels before reading |

## Common mistakes

| Wrong | Correct |
|-------|---------|
| memory_search when you know the label | memory_read with the exact label |
| Writing to an immutable label | Check memory_list first |
| Searching with very long queries | Keep search queries to key phrases |
