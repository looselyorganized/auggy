# Workspace Awareness for Persistent Agents

**Date:** 2026-07-13
**Status:** Implemented first slice; suitable for pre-release inclusion

## Finding

Auggy should treat `workspace/` as external, agent-managed memory: always make
its existence and shape visible, but load contents only when the current task
justifies inspection.

The strongest pattern in the literature is not “put everything in the prompt”
or “put everything in a vector database.” It is:

1. expose a compact orientation layer;
2. retrieve relevant evidence iteratively;
3. maintain durable artifacts through explicit operations;
4. keep destructive maintenance bounded and permissioned.

This closes a real gap in Auggy. Immutable identity supplies global guidance,
and `layeredMemory` retrieves peer-scoped facts from a database. The filesystem
could already read and write arbitrary workspace artifacts, but Auggy had no
automatic signal that those artifacts existed.

## Research Evidence

- **Catalog first, contents second.** [Infini Memory](https://arxiv.org/abs/2606.10677)
  stores maintainable topic documents, exposes a compact catalog, and lets the
  agent search and read bounded regions. Its results favor structured
  maintenance plus agentic retrieval over flat fragments or summary-only
  memory.
- **Use hierarchical orientation.** [HiGMem](https://arxiv.org/abs/2604.18349)
  uses concise summaries as semantic anchors before retrieving fine-grained
  evidence, improving retrieval precision while reducing retrieved context.
- **Keep most state outside active context.** [MemGPT](https://arxiv.org/abs/2310.08560)
  frames long-running agents as a tiered memory problem, with explicit movement
  between active context and external storage.
- **Make maintenance explicit.** [Agentic Memory / AgeMem](https://arxiv.org/abs/2601.01885)
  models retrieval, addition, updating, summarization, filtering, and deletion
  as agent actions. This supports active management, but its learned policy
  does not justify granting arbitrary models autonomous destructive cleanup.
- **Preserve verified reusable artifacts.** [Voyager](https://arxiv.org/abs/2305.16291)
  retrieves reusable skills and commits them after successful verification,
  instead of treating every intermediate attempt as durable knowledge.
- **Add richer indexing only when needed.** [A-MEM](https://arxiv.org/abs/2502.12110)
  demonstrates linked, evolving notes backed by embeddings and LLM maintenance.
  The benefits are promising, but the additional index, provider work, and
  synchronization are better introduced after simpler retrieval fails in
  measured workloads.

## Decision for Auggy

Keep workspace files as the source of truth and add a bounded metadata catalog
to each eligible turn.

For creator and agent turns, the filesystem augment now:

- announces the managed workspace and effective permissions;
- scans filenames and metadata only;
- skips hidden paths, configured exclusions, and symlinks;
- bounds traversal by depth and inspected-entry count;
- ranks paths using request terms, with modification time as fallback;
- marks catalog data as agent-derived, untrusted observation;
- directs the model to inspect existing work before creating a duplicate;
- leaves reads, writes, searches, and deletion to the existing trust-gated
  filesystem tools.

Public peers receive no catalog by default. File contents are never injected
automatically.

## Management Policy

“Manage and optimize” should mean:

- reuse or update a canonical artifact when one already represents the topic;
- choose stable, topic-oriented paths for durable work;
- make scratch artifacts visibly temporary;
- search beyond the catalog when its bounded view is inconclusive;
- remove obsolete temporary work only when deletion is authorized and the file
  has been checked.

It should not mean autonomous reorganization, merging, or deletion. Those
operations can destroy evidence, encode a model’s transient judgment into
durable state, and behave inconsistently across model providers.

## Release Recommendation

Ship the bounded catalog before release. It is file-native, opt-out, does not
require a database or embedding provider, and reuses existing filesystem trust
boundaries.

Hold these follow-on features until evaluation demonstrates a need:

- automatic content summaries;
- vector or graph indexes;
- background consolidation;
- autonomous file merging or deletion;
- cross-file link generation.

Evaluate the shipped design against policy-only and no-catalog baselines. Track
existing-artifact reuse, duplicate creation, discovery under truncation, tool
calls, prompt cost, resistance to instruction-like filenames, and unsafe
cleanup decisions.
