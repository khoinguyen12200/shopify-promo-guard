# MCP Tool Usage Rules

## code-review-graph — use FIRST for any code exploration

Before using Grep, Glob, or Read to explore the codebase, always try the
knowledge graph first. It is faster and gives structural context (callers,
dependents, impact radius) that file scanning cannot.

| Task | Tool to use first |
|---|---|
| Find where a function is used | `query_graph` with `callers_of` |
| Understand what a file depends on | `query_graph` with `imports_of` |
| Find tests for a module | `query_graph` with `tests_for` |
| Search by keyword or concept | `semantic_search_nodes` |
| Assess blast radius of a change | `get_impact_radius` |
| Review changed files | `detect_changes` + `get_review_context` |

Fall back to Grep/Glob/Read only when the graph returns no useful results.

## Shopify dev MCP — use BEFORE any admin UI changes

Any time you add, edit, or fix a Polaris component or App Bridge interaction
in `app/components/`, `app/routes/app/`, or `app/routes/admin/`:

1. `mcp__shopify-dev-mcp__learn_shopify_api` — load the relevant API context:
   - Admin app UI → `api: "polaris-app-home"`
   - Admin GraphQL mutations/queries → `api: "admin"`
   - Shopify Functions → `api: "functions"`

2. `mcp__shopify-dev-mcp__search_docs_chunks` — search for the specific
   component, prop, event, slot, or mutation you need.

3. Write code that matches the documented API exactly.

**Never guess Polaris component props, event names, slot names, or
show/hide methods.** The last time we guessed (`shopify.modal.show()`,
`showOverlay()` order, `onHide` vs `command="--hide"`), it cost multiple
debugging sessions. The MCP lookup takes 10 seconds.
