---
name: Explore Codebase
description: Navigate and understand codebase structure using the graphify knowledge graph
---

## Explore Codebase

Use graphify (`graphify-out/graph.json`) to navigate the codebase before
falling back to Grep/Glob/Read.

### Steps

1. Run `/graphify query "<your question>"` for broad BFS over the graph.
2. Run `/graphify query "<question>" --dfs` to trace a specific chain.
3. Run `/graphify path "NodeA" "NodeB"` to find shortest path between concepts.
4. Run `/graphify explain "NodeName"` to see a node's neighbors and source locations.
5. Skim `graphify-out/GRAPH_REPORT.md` for god nodes, surprising connections,
   and suggested cross-community questions.

### When the graph is stale

If you've made significant edits since the last graph build, rebuild:
- Incremental: `/graphify . --update` (fast for code-only changes)
- Full: `/graphify .` (slower, re-extracts docs via LLM)

### Tips

- Start broad (`query`), then narrow (`explain`, `path`).
- If a node has many INFERRED edges, treat them as hypotheses — verify in source.
- Community cohesion scores in the report flag clusters worth investigating.
